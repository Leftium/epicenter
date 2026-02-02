# Why Epicenter Uses a Contract-Based Architecture

One of the biggest challenges in building Epicenter was creating a truly isomorphic way of defining workspaces. The database client works everywhere. The YJS aspect works everywhere. But what about the parts that differ: providers, actions, handlers? These have different underlying implementations depending on the runtime environment.

## The Problem: Not Everything Is Isomorphic

A workspace has multiple components:

- **Tables**: YJS-backed CRUD operations
- **KV stores**: Key-value storage
- **Providers**: Persistence, sync, materializers (SQLite, markdown)
- **Actions**: Business logic (queries and mutations)

Tables and KV are pure YJS operations; they work identically in Node.js and browsers. But actions are different. An action handler might:

- Spawn a subprocess with `Bun.spawn`
- Read/write files with `Bun.file`
- Execute shell commands
- Call Node.js-specific APIs

These operations require a specific runtime. You can't run `Bun.spawn` in a browser.

## The Naive Approach: Handlers Everywhere

The first instinct was to define actions with their handlers inline:

```typescript
const blogWorkspace = defineWorkspace({
	id: 'blog',
	tables: { posts: { id: id(), title: text() } },
	actions: {
		publishPost: defineMutation({
			input: type({ id: 'string' }),
			output: type({ success: 'boolean' }),
			// Handler defined inline
			handler: async (input, ctx) => {
				await Bun.$`echo "Publishing ${input.id}"`;
				ctx.tables.posts.update({ id: input.id, published: true });
				return { success: true };
			},
		}),
	},
});
```

This approach has problems:

1. **Can't run in browsers**: The handler references `Bun.$`, which doesn't exist in browsers
2. **Can't serialize**: Functions aren't JSON-serializable
3. **Can't introspect**: Tools like MCP servers and CLI generators can't examine the action schema without executing code
4. **All or nothing**: Even if you only need tables, you're forced to include the Bun runtime

## The Solution: Separate Contracts from Handlers

The insight was to split workspace definitions into two parts:

1. **Contracts**: JSON-serializable descriptions of _what_ exists (tables, actions with input/output schemas)
2. **Handlers**: Runtime implementations of _how_ actions execute

```typescript
// Contract: Pure data, no functions, JSON-serializable
const blogWorkspace = defineWorkspace({
	id: 'blog',
	tables: {
		posts: { id: id(), title: text(), published: boolean({ default: false }) },
	},
	actions: {
		publishPost: defineMutation({
			input: type({ id: 'string' }),
			output: type({ success: 'boolean' }),
			description: 'Publish a blog post',
			// No handler here - just the schema
		}),
	},
});

// Handler binding: Only where Bun runtime exists
const serverClient = await blogWorkspace
	.withProviders({ sqlite: sqliteProvider })
	.createWithHandlers({
		publishPost: async (input, ctx) => {
			await Bun.$`echo "Publishing ${input.id}"`;
			ctx.tables.posts.update({ id: input.id, published: true });
			return { success: true };
		},
	});
```

## What This Enables

### 1. Browser Clients Without Bun

The browser can create a full client without any Bun dependency:

```typescript
// Browser: Tables work, actions proxy to server
const browserClient = await blogWorkspace
	.withProviders({ indexeddb: idbProvider })
	.createHttpClient('http://localhost:3913');

// Tables work locally (pure YJS)
browserClient.$tables.posts.upsert({ id: '1', title: 'Hello' });

// Actions proxy over HTTP
await browserClient.publishPost({ id: '1' });
// → POST http://localhost:3913/workspaces/blog/actions/publishPost
```

The browser client has full table functionality. It can read, write, and observe changes; all without Bun. Actions that need server-side execution just proxy over HTTP.

### 2. Tauri Apps Without Bun Binaries

This was a critical requirement. Tauri apps ship as native binaries. Including Bun would add significant megabytes to every release.

With contracts, Tauri apps can:

- Initialize full workspace clients in the browser context
- Use tables and KV stores directly
- Proxy actions to a local or remote server when needed

No Bun binary required in the app bundle.

### 3. JSON-Serializable for Tooling

Because contracts are pure data, tools can introspect them:

```typescript
// MCP server generation
for (const { path, contract } of walkActionContracts(workspace.actions)) {
	const tool = {
		name: path.join('.'),
		description: contract.description,
		inputSchema: toJsonSchema(contract.input),
	};
	mcpServer.registerTool(tool);
}

// CLI generation
for (const { path, contract } of walkActionContracts(workspace.actions)) {
	const command = yargs.command(path.join(' '), contract.description, {
		...toYargsOptions(contract.input),
	});
}

// OpenAPI documentation
const openApiSpec = generateOpenApi(workspace.actions);
```

### 4. The Dream: Plain JSON Config Files

Because contracts are JSON-serializable, they could theoretically be stored as `.json` files:

```json
{
	"id": "blog",
	"tables": {
		"posts": {
			"id": { "type": "id" },
			"title": { "type": "text" },
			"published": { "type": "boolean", "default": false }
		}
	},
	"actions": {
		"publishPost": {
			"type": "mutation",
			"input": {
				"type": "object",
				"properties": { "id": { "type": "string" } }
			},
			"output": {
				"type": "object",
				"properties": { "success": { "type": "boolean" } }
			}
		}
	}
}
```

This unlocks something powerful: **language-agnostic workspace definitions**.

A Tauri app (Rust + TypeScript) could:

- Read workspace config with Rust's `serde_json`
- Modify the config in Rust
- Write changes back to JSON
- Have the TypeScript side pick up the changes

No TypeScript execution in Bun required to understand or modify workspace definitions.

### 5. Self-Editing Config Apps

The experimental `apps/epicenter` app aims to let users edit their workspace configurations visually. Originally, this seemed to require shipping Bun to read `.ts` config files.

With JSON contracts, the app can:

1. Read workspace config as JSON (Rust or TypeScript, no Bun needed)
2. Present a visual editor for tables, actions, KV stores
3. Write changes back to JSON
4. Have a separate CLI (with Bun) execute actions when needed

The editing experience doesn't require the runtime execution environment.

## The Contract Type

The `WorkspaceContract` type is intentionally simple:

```typescript
type WorkspaceContract<TId, TSchema, TActions> = {
	id: TId;
	tables: TSchema;
	actions: TActions;
	description?: string;
};
```

No methods. No functions. Pure data.

The `defineWorkspace()` function takes a contract and returns a `Workspace` object with fluent methods (`.withProviders()`, `.createWithHandlers()`, `.createHttpClient()`). The contract remains serializable; the runtime behavior is added on top.

## Handler Context

When handlers are bound, they receive a context object:

```typescript
type HandlerContext = {
	tables: Tables; // YJS-backed table operations
	schema: Schema; // Table definitions
	validators: Validators; // Runtime validators
	providers: Providers; // Provider exports (SQLite, etc.)
	paths?: WorkspacePaths; // Filesystem paths (undefined in browser)
};
```

Handlers have full access to the workspace's runtime capabilities. They just aren't part of the contract definition.

## Summary

The contract-based architecture solves a fundamental tension: workspace definitions need to be shareable and inspectable, but implementations need runtime-specific capabilities.

By separating contracts (JSON-serializable data) from handlers (runtime functions):

- Tables and KV work everywhere without Bun
- Browsers can create full clients that proxy actions over HTTP
- Tauri apps don't need bundled runtimes
- Tools can introspect schemas without executing code
- Configs could be plain JSON, editable by any language

The architecture makes Epicenter truly isomorphic: the same contract works in Node.js, browsers, and Tauri apps; only the handler binding differs by environment.
