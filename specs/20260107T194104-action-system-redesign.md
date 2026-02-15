# Action System Redesign

**Status:** Draft  
**Created:** 2026-01-07  
**Author:** Braden Wong

## Overview

Reintroduce actions as a lightweight boundary layer for exposing workspace functionality via HTTP, MCP, and CLI. Actions are plain objects defined separately from capabilities, passed to `createServer` and `createCLI` as a second argument.

This design avoids the complexity of the previous action system (8+ overloads, `ctx` object, unclear registration timing) while preserving the benefits of declarative contracts for cross-boundary invocation.

## Background

### Why Actions Were Removed (PR #1209)

The previous action system was removed because:

1. **8+ function overloads**: Tracking sync/async, `Result<T,E>` vs raw `T`, with/without input created combinatorial explosion
2. **Redundant `ctx` object**: Handlers received `(input, ctx)` where `ctx` was essentially the workspace client
3. **Unclear registration timing**: Should actions be registered at workspace definition, `.create()`, or server creation?
4. **Contract/handler separation complexity**: Added ceremony without clear value

### What We Learned

The "just write functions" approach that replaced actions is simpler for internal logic, but we lose:

- Automatic MCP tool generation
- Automatic OpenAPI documentation
- Automatic CLI command generation
- Input validation at boundaries
- Introspectable action metadata

### The New Insight

**Capabilities and actions serve different purposes:**

- **Capabilities**: Internal runtime APIs (SQLite connections, file watchers, sync providers)
- **Actions**: External boundary contracts (what can be invoked remotely, with validation)

Actions should be defined **after** client creation, **separately** from capabilities, and passed to adapters (server, CLI) explicitly.

## Proposed Design

### The Flow

```
1. Define Workspace Schema
        ↓
2. Create Client with Capabilities
        ↓
3. Define Actions (wrapping client methods)
        ↓
4. Pass to Server/CLI
```

### Code Example

```typescript
import { defineWorkspace, defineQuery, defineMutation } from '@epicenter/hq';
import { type } from 'arktype';

// Step 1: Define workspace
const workspace = defineWorkspace({
	id: 'blog',
	guid: 'abc-123',
	tables: { posts: { id: id(), title: text(), content: text() } },
	kv: {},
});

// Step 2: Create client with capabilities
const client = await workspace.create({ sqlite, persistence, markdown });

// Step 3: Define actions (wrapping client methods)
const actions = {
	posts: {
		getAll: defineQuery({
			handler: () => client.tables.posts.getAllValid(),
		}),
		create: defineMutation({
			input: type({ title: 'string', content: 'string' }),
			handler: ({ title, content }) => {
				const id = generateId();
				client.tables.posts.upsert({ id, title, content });
				return { id };
			},
		}),
		get: defineQuery({
			input: type({ id: 'string' }),
			output: type({ id: 'string', title: 'string', content: 'string' }),
			handler: ({ id }) => client.tables.posts.get({ id }),
		}),
	},
	sync: {
		markdown: defineMutation({
			description: 'Sync markdown files to YJS',
			handler: () => client.capabilities.markdown.pullFromMarkdown(),
		}),
	},
};

// Step 4: Pass to server and/or CLI
const server = createServer(client, { actions });
const cli = createCLI(client, { actions });
```

## Type Definitions

### Action Types

````typescript
import type { StandardSchemaV1, CombinedStandardSchema } from './schema';

/**
 * Base configuration shared by queries and mutations.
 */
type ActionConfig<
	TInput extends CombinedStandardSchema | undefined = undefined,
	TOutput = unknown,
> = {
	/** Human-readable description for docs and MCP tool descriptions */
	description?: string;

	/** Input schema for validation and JSON Schema generation */
	input?: TInput;

	/** Output schema for documentation (optional, can be inferred) */
	output?: CombinedStandardSchema;

	/** The handler function. Receives validated input if `input` is defined. */
	handler: TInput extends CombinedStandardSchema
		? (
				input: StandardSchemaV1.InferOutput<TInput>,
			) => TOutput | Promise<TOutput>
		: () => TOutput | Promise<TOutput>;
};

/**
 * Query - a read operation exposed via GET endpoints.
 *
 * Queries enable:
 * - REST API GET endpoints
 * - MCP tool definitions (read-only)
 * - CLI commands
 * - OpenAPI documentation
 */
export type Query<
	TInput extends CombinedStandardSchema | undefined = undefined,
	TOutput = unknown,
> = ActionConfig<TInput, TOutput> & {
	/** Discriminator for runtime type checking */
	type: 'query';
};

/**
 * Mutation - a write operation exposed via POST endpoints.
 *
 * Mutations enable:
 * - REST API POST endpoints
 * - MCP tool definitions (with side effects)
 * - CLI commands
 * - OpenAPI documentation
 */
export type Mutation<
	TInput extends CombinedStandardSchema | undefined = undefined,
	TOutput = unknown,
> = ActionConfig<TInput, TOutput> & {
	/** Discriminator for runtime type checking */
	type: 'mutation';
};

/** Union type for any action (query or mutation) */
export type Action<
	TInput extends CombinedStandardSchema | undefined = undefined,
	TOutput = unknown,
> = Query<TInput, TOutput> | Mutation<TInput, TOutput>;

/**
 * Actions can nest to any depth.
 * Leaves must be Action objects (have `type` and `handler`).
 *
 * @example Flat structure
 * ```typescript
 * const actions = {
 *   getUser: defineQuery({ handler: ... }),
 *   createUser: defineMutation({ handler: ... }),
 * };
 * ```
 *
 * @example Nested structure
 * ```typescript
 * const actions = {
 *   users: {
 *     getAll: defineQuery({ handler: ... }),
 *     create: defineMutation({ handler: ... }),
 *   },
 * };
 * ```
 */
export type Actions = {
	[key: string]: Action<any, any> | Actions;
};
````

### Helper Functions

````typescript
/**
 * Define a query (read operation) with full type inference.
 *
 * The `type: 'query'` discriminator is attached automatically.
 *
 * @example No input - handler has no arguments
 * ```typescript
 * const getAllPosts = defineQuery({
 *   handler: () => client.tables.posts.getAllValid(),
 * });
 * ```
 *
 * @example With input - handler receives typed input
 * ```typescript
 * const getPost = defineQuery({
 *   input: type({ id: 'string' }),
 *   handler: ({ id }) => client.tables.posts.get({ id }),
 * });
 * ```
 */
export function defineQuery<
	TInput extends CombinedStandardSchema | undefined = undefined,
	TOutput = unknown,
>(config: Omit<Query<TInput, TOutput>, 'type'>): Query<TInput, TOutput> {
	return { type: 'query', ...config };
}

/**
 * Define a mutation (write operation) with full type inference.
 *
 * The `type: 'mutation'` discriminator is attached automatically.
 *
 * @example No input - handler has no arguments
 * ```typescript
 * const syncMarkdown = defineMutation({
 *   description: 'Sync markdown files to YJS',
 *   handler: () => client.capabilities.markdown.pullFromMarkdown(),
 * });
 * ```
 *
 * @example With input - handler receives typed input
 * ```typescript
 * const createPost = defineMutation({
 *   input: type({ title: 'string' }),
 *   handler: ({ title }) => {
 *     client.tables.posts.upsert({ id: generateId(), title });
 *   },
 * });
 * ```
 */
export function defineMutation<
	TInput extends CombinedStandardSchema | undefined = undefined,
	TOutput = unknown,
>(config: Omit<Mutation<TInput, TOutput>, 'type'>): Mutation<TInput, TOutput> {
	return { type: 'mutation', ...config };
}
````

### Why Separate Functions?

Using `defineQuery` and `defineMutation` instead of a single `defineAction({ type: '...' })`:

1. **Industry standard**: Matches TanStack Query, tRPC, RTK Query, GraphQL conventions
2. **Cleaner call sites**: No redundant `type` field to pass
3. **Better IDE experience**: Hover shows `defineQuery<...>` vs `defineAction<..., 'query'>`
4. **Simpler types**: No union type for the `type` field

```typescript
// ✅ Clean - type is implicit
const actions = {
  posts: {
    getAll: defineQuery({ handler: ... }),
    create: defineMutation({ handler: ... }),
  },
};

// ❌ Redundant - type is explicit
const actions = {
  posts: {
    getAll: defineAction({ type: 'query', handler: ... }),
    create: defineAction({ type: 'mutation', handler: ... }),
  },
};
```

### Why No `defineActions`?

A `defineActions` helper is **not necessary** because:

1. Each leaf action is already typed via `defineQuery`/`defineMutation`
2. TypeScript infers the nested structure automatically from the leaves
3. It would just be an identity function with no type inference benefit

```typescript
// This works fine - TypeScript infers the full structure
const actions = {
  posts: {
    create: defineMutation({ ... }), // Already typed
    getAll: defineQuery({ ... }), // Already typed
  },
};
// actions.posts.create is fully typed ✓
```

## Server and CLI Integration

### createServer Signature

```typescript
/**
 * Create an HTTP server from a workspace client and actions.
 *
 * @param client - The workspace client
 * @param options - Server options including actions to expose
 */
function createServer(
	client: WorkspaceClient,
	options: {
		actions: Actions;
		port?: number;
	},
): Server;
```

### createCLI Signature

```typescript
/**
 * Create a CLI from a workspace client and actions.
 *
 * @param client - The workspace client
 * @param options - CLI options including actions to expose
 */
function createCLI(
	client: WorkspaceClient,
	options: {
		actions: Actions;
	},
): CLI;
```

### Route/Command Generation

From the action tree, adapters generate:

| Adapter     | Action Path    | Generated                           |
| ----------- | -------------- | ----------------------------------- |
| **HTTP**    | `posts.create` | `POST /posts/create`                |
| **HTTP**    | `posts.getAll` | `GET /posts/getAll`                 |
| **MCP**     | `posts.create` | Tool `posts_create`                 |
| **CLI**     | `posts.create` | `cli posts create --title "Hello"`  |
| **OpenAPI** | `posts.create` | Operation with input/output schemas |

## Design Decisions

### Why Plain Objects Instead of Callable Functions?

The old system made actions callable (`action(input)`). The new system uses plain objects because:

1. **Simpler types**: No need for callable + properties hybrid
2. **Easier introspection**: Just read `action.type`, `action.input`, etc.
3. **No confusion**: Actions are data describing behavior, not the behavior itself
4. **Adapters invoke**: The server/CLI adapter calls `action.handler(input)`, not user code

### Why `CombinedStandardSchema` for Input?

Input schemas must support JSON Schema generation for:

- MCP tool `inputSchema`
- OpenAPI request body schemas
- CLI flag generation

`CombinedStandardSchema` ensures the schema can be converted to JSON Schema. ArkType and Zod (v4.2+) both satisfy this constraint.

### Why Output is Optional?

1. TypeScript can infer the handler return type
2. Output schema is only needed for explicit documentation
3. Most actions don't need it
4. Keeps the common case simple

### Why No Overloads?

The old system had 8 overloads per function to track:

- With/without input (2x)
- Sync/async handler (2x)
- Returns `Result<T,E>` vs raw `T` (2x)

The new system avoids this by:

1. **Conditional handler type**: If `input` is defined, handler receives it; otherwise no args
2. **Union return type**: Handler returns `T | Promise<T>` - runtime handles both
3. **No Result tracking**: Handler can return `Result` or raw value - adapters handle both

### Why Separate from Capabilities?

Capabilities are internal runtime APIs that may:

- Not be JSON-serializable
- Have complex dependencies
- Manage resources and lifecycle

Actions are external boundary contracts that must:

- Have JSON-serializable inputs/outputs
- Be introspectable without runtime initialization
- Be safe to expose publicly

Mixing them creates confusion about what's internal vs external.

## Implementation Plan

- [x] **Create `core/actions.ts`** with new types
  - [x] `Action` type with conditional handler signature (unified, not separate Query/Mutation)
  - [x] `Actions` type for nested structure
  - [x] `defineAction()` helper function (single function, type discriminated by `type` field)
  - [x] `isAction()`, `isQuery()`, `isMutation()` type guards
  - [x] `iterateActions()` generator for tree traversal
- [x] **Update `server/server.ts`**
  - [x] Accept `{ actions }` as second argument to `createServer`
  - [x] Walk action tree to generate routes via `createActionsPlugin`
  - [x] Use `action.type` to determine HTTP method (GET vs POST)
  - [x] Validate input with `action.input` schema
- [x] **Update `cli/cli.ts`**
  - [x] Accept `{ actions }` as second argument to `createCLI`
  - [x] Walk action tree to generate commands
  - [x] Convert `action.input` to CLI flags via JSON Schema
- [ ] **Update MCP integration** (deferred to future work)
  - [ ] Walk action tree to generate tools
  - [ ] Use `action.input` for tool `inputSchema`
  - [ ] Use `action.description` for tool description
- [x] **Update exports in `index.ts`**
  - [x] Export `Action`, `Actions` types
  - [x] Export `defineAction` function
  - [x] Export type guards and `iterateActions`
- [ ] **Update documentation** (deferred to future work)
  - [ ] `packages/epicenter/README.md`
  - [ ] `packages/epicenter/src/server/README.md`
  - [ ] `packages/epicenter/src/cli/README.md`

## Files to Change

| File                                      | Changes                           |
| ----------------------------------------- | --------------------------------- |
| `packages/epicenter/src/core/actions.ts`  | New file with types and helpers   |
| `packages/epicenter/src/server/server.ts` | Accept actions, generate routes   |
| `packages/epicenter/src/cli/cli.ts`       | Accept actions, generate commands |
| `packages/epicenter/src/index.ts`         | Export new types and functions    |
| `packages/epicenter/README.md`            | Update documentation              |

## Migration Notes

This is a **new feature**, not a breaking change. The previous action system was already removed.

Users can adopt actions incrementally:

```typescript
// Before: No actions, just functions
const client = await workspace.create({ sqlite });
function createPost(title: string) { ... }
app.post('/posts', (req) => createPost(req.body.title));

// After: With actions
const client = await workspace.create({ sqlite });
const actions = {
  posts: {
    create: defineMutation({
      input: type({ title: 'string' }),
      handler: ({ title }) => { ... },
    }),
  },
};
const server = createServer(client, { actions });
```

## Comparison with Old System

| Aspect          | Old System              | New System                     |
| --------------- | ----------------------- | ------------------------------ |
| Overloads       | 8 per function          | 0                              |
| Handler context | `(input, ctx)`          | `(input)` - closes over client |
| Registration    | `.withActions()` chain  | Separate, passed to server/CLI |
| Callable        | Yes, `action(input)`    | No, plain object               |
| Type complexity | High (4 generic params) | Low (2 generic params)         |
| Lines of code   | ~743                    | ~100 estimated                 |

## Review

### What Was Implemented

The action system was implemented across 4 incremental commits ("waves"):

| Wave | Commit      | Description                                                                                |
| ---- | ----------- | ------------------------------------------------------------------------------------------ |
| 1    | `31f480795` | Core types: `Action`, `Actions`, `defineAction()`, type guards, `iterateActions` generator |
| 2    | `9b47484a4` | Server: `createActionsPlugin` generates REST routes from action tree                       |
| 3    | `1d8fa0c19` | CLI: Action commands generated from action definitions with flag generation                |
| 4    | `12d9b426e` | Exports: Public API exports in index.ts                                                    |

### Design Deviations from Original Plan

1. **Single `Action` type instead of separate `Query`/`Mutation` types**
   - Original plan: Two separate types and `defineQuery`/`defineMutation` functions
   - Implemented: Single `Action<TInput, TOutput>` type with `type: 'query' | 'mutation'` discriminant
   - Rationale: Simpler, fewer exports, type field already distinguishes behavior

2. **`iterateActions` generator instead of `walkActions` callback**
   - Original plan: Callback-based visitor pattern
   - Implemented: Generator that yields `[action, path]` tuples
   - Rationale: Cleaner composition, enables `for...of`, spread/map patterns, early termination

3. **MCP integration deferred**
   - The MCP tool generation was not implemented in this phase
   - Can be added later using the same `iterateActions` pattern

### Files Changed

| File                                       | Change                                                |
| ------------------------------------------ | ----------------------------------------------------- |
| `packages/epicenter/src/core/actions.ts`   | New - types, `defineAction`, guards, `iterateActions` |
| `packages/epicenter/src/server/actions.ts` | New - `createActionsPlugin` for route generation      |
| `packages/epicenter/src/server/server.ts`  | Modified - accepts `{ actions }` option               |
| `packages/epicenter/src/cli/cli.ts`        | Modified - generates commands from actions            |
| `packages/epicenter/src/index.ts`          | Modified - exports action system                      |

### Lines of Code

- `core/actions.ts`: ~265 lines (vs ~743 in old system)
- `server/actions.ts`: ~110 lines
- Total new code: ~375 lines

### Testing Status

- Type-check: Passing
- Runtime tests: Not yet written (planned)
