# Epicenter Server

Expose your workspace tables as REST APIs and WebSocket sync endpoints.

## What This Does

Epicenter uses a two-tier server architecture to handle local data and cloud coordination:

1. **Local Server** (`createLocalServer`): Runs on your device (often as a Tauri sidecar). It provides fast, sub-millisecond sync between your UI and local Y.Doc, and exposes your workspace tables via REST.
2. **Hub Server** (`createHubServer`): Runs in the cloud or on a central home server. It acts as the primary sync relay between all your devices and provides centralized services like AI streaming, authentication, and API key management.

The key difference from running scripts:

- **Scripts**: Client is alive only during the `using` block, then auto-disposed.
- **Server**: Clients stay alive until you manually stop the server (Ctrl+C).

## Quick Start

### Local Server (Workspace CRUD + Sync)

```typescript
import {
	defineWorkspace,
	createWorkspace,
	id,
	text,
} from '@epicenter/workspace/static';
import { createLocalServer } from '@epicenter/server';

// 1. Define workspace
const blogWorkspace = defineWorkspace({
	id: 'blog',
	tables: {
		posts: { id: id(), title: text() },
	},
});

// 2. Create client
const blogClient = createWorkspace(blogWorkspace);

// 3. Create and start local server
const server = createLocalServer({ clients: [blogClient], port: 3913 });
server.start();
```

Now your tables are available as REST endpoints:

- `GET http://localhost:3913/workspaces/blog/tables/posts`
- `POST http://localhost:3913/workspaces/blog/tables/posts`

### Hub Server (Sync Relay + AI + Auth)

```typescript
import { createHubServer } from '@epicenter/server';

// Start a minimal hub for development
const hub = createHubServer({ port: 3914 });
hub.start();
```

## API

### `createLocalServer(config)`

The local server exposes workspace tables and actions. It's designed to run close to the data.

**Signature:**

```typescript
function createLocalServer(config: LocalServerConfig): Server;

type LocalServerConfig = {
	/** Workspace clients to expose via REST CRUD and action endpoints. */
	clients: AnyWorkspaceClient[];
	/** Port to listen on. Defaults to 3913 (or PORT env var). */
	port?: number;
	/** Hub URL for session token validation. Omit for open mode. */
	hubUrl?: string;
	/** CORS allowed origins. Default: ['tauri://localhost'] */
	allowedOrigins?: string[];
	/** Sync plugin options. */
	sync?: {
		auth?: AuthConfig;
		onRoomCreated?: (roomId: string, doc: Y.Doc) => void;
		onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
	};
};
```

### `createHubServer(config)`

The hub is the coordination point for the ecosystem. It handles sync relaying, AI proxying, and authentication.

**Signature:**

```typescript
function createHubServer(config: HubServerConfig): Server;

type HubServerConfig = {
	/** Port to listen on. Defaults to 3913 (or PORT env var). */
	port?: number;
	/** Better Auth configuration for session-based auth. */
	auth?: AuthPluginConfig;
	/** Sync plugin options. */
	sync?: {
		auth?: AuthConfig;
		onRoomCreated?: (roomId: string, doc: Y.Doc) => void;
		onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
	};
};
```

### Server Methods

Both server types return a consistent interface:

```typescript
const server = createLocalServer({ clients: [blogClient] });

server.app; // Underlying Elysia instance
server.start(); // Start the HTTP server
await server.stop(); // Stop server and cleanup resources
```

## Composable Plugins

The servers are built from modular Elysia plugins.

#### `@epicenter/server/sync` (Shared)

Provides document synchronization (WebSocket real-time sync + HTTP document state access). Used by both Hub and Local servers.

| Method        | Route    | Description                                                     |
| ------------- | -------- | --------------------------------------------------------------- |
| `GET`         | `/`      | List active rooms with connection counts                        |
| `WS/GET/POST` | `/:room` | Real-time sync (WS), document state (GET), apply updates (POST) |

#### `createWorkspacePlugin(clients)` (Local Only)

Exposes the RESTful tables and actions for the provided clients.

```typescript
import { createWorkspacePlugin } from '@epicenter/server/workspace';

const app = new Elysia().use(createWorkspacePlugin([blogClient])).listen(3913);
```

#### `createAIPlugin(config)` (Hub Only)

Provides AI streaming and proxying capabilities.

## Deployment Modes

### Local Server Composition

`createLocalServer()` composes local-first features:

```
createLocalServer()
├── Sync Plugin        → /rooms/:room           (Local sync relay)
├── Workspace Plugin   → /workspaces/:id/...    (REST CRUD + Actions)
└── CORS + Auth        (Tauri-only protection)
```

### Hub Server Composition

`createHubServer()` composes coordination features:

```
createHubServer()
├── Sync Plugin        → /rooms/:room           (Cloud sync relay)
├── AI Plugin          → /ai/...                (Streaming)
├── Auth Plugin        → /auth/...              (Better Auth)
└── Proxy Plugin       → /proxy/:provider/*     (AI provider proxy, env var keys)
```

## URL Hierarchy

### Local Server

```
/                                              - Discovery root
/rooms/                                        - Active rooms
/rooms/{workspaceId}                           - WebSocket sync
/workspaces/{workspaceId}/tables/{table}       - RESTful table CRUD
/workspaces/{workspaceId}/actions/{action}     - Workspace actions
```

### Hub Server

```
/                                              - Discovery root
/rooms/                                        - Active rooms
/rooms/{roomId}                                - WebSocket sync relay
/ai/chat                                       - AI streaming endpoint
/auth/*                                        - Better Auth endpoints
/proxy/{provider}/*                            - AI provider proxy (env var keys)
```

## WebSocket Sync

The server's primary real-time feature is WebSocket-based Y.Doc synchronization.

### Client Connection

Clients connect to:

```
ws://host:3913/rooms/{workspaceId}
```

The recommended client is `@epicenter/sync` (via `createSyncExtension` from `@epicenter/workspace/extensions/sync`):

```typescript
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';

const client = createClient(definition.id)
	.withDefinition(definition)
	.withExtension(
		'sync',
		createSyncExtension({
			url: 'ws://localhost:3913/rooms/{id}',
		}),
	);
```

### Protocol

The sync plugin implements the y-websocket protocol with one custom extension:

| Message Type    | Tag | Direction                | Purpose                                       |
| --------------- | --- | ------------------------ | --------------------------------------------- |
| SYNC            | 0   | Bidirectional            | Document synchronization (step 1, 2, updates) |
| AWARENESS       | 1   | Bidirectional            | User presence (cursors, names, selections)    |
| QUERY_AWARENESS | 3   | Client → Server          | Request current awareness states              |
| SYNC_STATUS     | 102 | Client → Server → Client | Heartbeat + `hasLocalChanges` tracking        |

**MESSAGE_SYNC_STATUS (102)**: The client sends its local version counter. The server echoes the raw bytes back unchanged. This enables the client to know when all local changes have reached the server, powering "Saving..." / "Saved" UI.

### Room Management

Each workspace ID or room name maps to a room. When the last client disconnects, a **60-second eviction timer** starts. If no new client connects within that window, the room is destroyed and its resources released.

## CLI Usage

Each server mode has its own entry point:

```bash
# Start hub server (sync relay + AI + auth)
bun run src/start-hub.ts

# Start local server (sync relay + workspace CRUD, no AI)
bun run src/start-local.ts
```

The `serve` command in the Epicenter CLI uses `createLocalServer` to expose your local workspaces.

## Server vs Scripts

### Use Scripts (Direct Client)

```typescript
{
	await using client = createWorkspace(blogWorkspace);
	client.tables.posts.upsert({ id: '1', title: 'Hello' });
}
```

**Good for:** One-off migrations, data imports, CLI tools.

### Use Server (HTTP Wrapper)

```typescript
const client = createWorkspace(blogWorkspace);
const server = createLocalServer({ clients: [client] });
server.start();
```

**Good for:** Web applications, API backends, real-time collaboration.

### Running Scripts While Server is Active

Use the HTTP API instead of creating another client to avoid storage conflicts:

```typescript
await fetch('http://localhost:3913/workspaces/blog/tables/posts', {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ id: '1', title: 'New Post' }),
});
```

## RESTful Tables (Local Server)

Tables are automatically exposed as CRUD endpoints on the local server:

| Method   | Path                                          | Description          |
| -------- | --------------------------------------------- | -------------------- |
| `GET`    | `/workspaces/{workspace}/tables/{table}`      | List all valid rows  |
| `GET`    | `/workspaces/{workspace}/tables/{table}/{id}` | Get single row by ID |
| `POST`   | `/workspaces/{workspace}/tables/{table}`      | Create or upsert row |
| `PUT`    | `/workspaces/{workspace}/tables/{table}/{id}` | Update row fields    |
| `DELETE` | `/workspaces/{workspace}/tables/{table}/{id}` | Delete row           |

### Response Format

**Success:**

```json
{ "data": { "id": "123", "title": "Hello" } }
```

**Error:**

```json
{ "error": { "message": "What went wrong" } }
```

## Lifecycle Management

```typescript
const server = createLocalServer({ clients: [blogClient] });

// Start the server
server.start();

// Stop manually or wire up to SIGINT/SIGTERM:
await server.stop(); // Stops server, cleans up all clients and resources
```
