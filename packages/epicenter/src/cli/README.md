# Epicenter CLI

Start your Epicenter server from the command line.

## What This Does

The CLI starts an HTTP server that exposes your workspace tables via REST API and WebSocket sync.

```bash
epicenter [--port 3913]
```

Running `epicenter` without arguments starts the server on the default port (3913).

## How It Works

### 1. Define Your Workspace

```typescript
import { defineWorkspace, id, text, boolean } from '@epicenter/hq';

const blogWorkspace = defineWorkspace({
	id: 'blog',
	tables: {
		posts: {
			id: id(),
			title: text(),
			published: boolean({ default: false }),
		},
	},
});
```

### 2. Create an Epicenter Config

In your project root, create `epicenter.config.ts`:

```typescript
import { sqliteProvider } from '@epicenter/hq';
import { blogWorkspace } from './workspaces/blog';

const blogClient = await blogWorkspace
	.withProviders({ sqlite: sqliteProvider })
	.create();

export default [blogClient];
```

### 3. Start the Server

```bash
epicenter
```

This starts the server with:

- REST API at `/workspaces/{workspace}/tables/{table}`
- WebSocket sync at `/workspaces/{workspace}/sync`
- OpenAPI docs at `/openapi`

## CLI Options

| Option      | Description               | Default |
| ----------- | ------------------------- | ------- |
| `--port`    | Port to run the server on | 3913    |
| `--help`    | Show help                 |         |
| `--version` | Show version              |         |

## Writing Custom Actions

The CLI doesn't map actions to commands. Instead, write regular functions that use your client and expose them however you prefer:

```typescript
// actions.ts
import { blogClient } from './epicenter.config';

export function createPost(title: string) {
	const id = generateId();
	blogClient.tables.posts.upsert({ id, title, published: false });
	return { id };
}

export function publishPost(id: string) {
	blogClient.tables.posts.update({ id, published: true });
}
```

Then expose via HTTP endpoints, MCP server, or your own CLI:

```typescript
// Custom CLI script
const [command, ...args] = process.argv.slice(2);
if (command === 'create') createPost(args[0]);
if (command === 'publish') publishPost(args[0]);
```

## Testing

Test your configuration programmatically:

```typescript
import { createCLI } from '@epicenter/hq/cli';

const clients = await loadClients();
const cli = createCLI(clients);
await cli.run(['--port', '8080']);
```

## File Organization

- `bin.ts`: Entry point for CLI executable
- `cli.ts`: Core CLI creation logic
- `discovery.ts`: Config file discovery and loading
- `index.ts`: Public API exports

## Philosophy

The CLI is intentionally simple: it just starts a server. Business logic belongs in your application code, not in CLI commands. Use the REST API or WebSocket sync to interact with your data.
