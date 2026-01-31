# Workspace

A workspace is a self-contained domain module with its own definition and capabilities.

## Two-Phase Initialization

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   defineWorkspace()              createClient() Builder Pattern             │
│   ─────────────────              ──────────────────────────────             │
│                                                                             │
│   ┌─────────────────┐           createClient(workspaceId, { epoch? })       │
│   │ Pure Definition │                         │                             │
│   │                 │           ┌─────────────┴─────────────┐               │
│   │ - id            │           │                           │               │
│   │ - name          │           ▼                           ▼               │
│   │ - tables        │    .withDefinition(def)        .withExtensions({})    │
│   │ - kv            │           │                           │               │
│   └─────────────────┘           ▼                           ▼               │
│                          .withExtensions({})         WorkspaceClient        │
│   Static (no I/O)               │                    (dynamic definition)   │
│                                 ▼                                           │
│                          WorkspaceClient                                    │
│                          (static definition)                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **`defineWorkspace()`**: Pure definition. No I/O. Just describes the shape.
- **`createClient()`**: Returns a builder. Chain `.withDefinition()` for static definition, then `.withExtensions()` to create the client.

## Minimal vs Full Definition

`defineWorkspace()` accepts either minimal input or a full definition (all-or-nothing):

```typescript
// Minimal input (developer ergonomics) — ALL tables are just fields
const workspace = defineWorkspace({
	id: 'epicenter.whispering',
	tables: {
		recordings: { id: id(), title: text(), transcript: text() },
		transformations: { id: id(), name: text(), prompt: text() },
	},
	kv: {},
});

// Full definition (explicit metadata) — ALL tables have full metadata
const workspace = defineWorkspace({
	id: 'epicenter.whispering',
	name: 'Whispering',
	tables: {
		recordings: {
			name: 'Recordings',
			icon: { type: 'emoji', value: '🎙️' },
			description: 'Voice recordings',
			fields: { id: id(), title: text(), transcript: text() },
		},
		transformations: {
			name: 'Transformations',
			icon: { type: 'emoji', value: '✨' },
			description: 'Text transformations',
			fields: { id: id(), name: text(), prompt: text() },
		},
	},
	kv: {},
});
```

When using minimal input, defaults are applied:

- `name` defaults to humanized `id` (e.g., "epicenter.whispering" → "Epicenter whispering")
- Table `name` defaults to humanized key (e.g., "blogPosts" → "Blog posts")
- Table `icon` defaults to `{ type: 'emoji', value: '📄' }`
- Table `description` defaults to `''`

**Note**: No mixing allowed. Either all tables are minimal or all have full metadata.

## What is a Workspace?

Each workspace creates its own independent client:

```typescript
// Step 1: Define the workspace (pure, no I/O)
const whisperingWorkspace = defineWorkspace({
	id: 'epicenter.whispering',
	tables: {
		recordings: { id: id(), title: text(), transcript: text() },
	},
	kv: {},
});

// Step 2: Create client at a specific epoch using the builder pattern
const client = createClient(whisperingWorkspace.id, { epoch: 0 })
	.withDefinition(whisperingWorkspace)
	.withExtensions({ sqlite, persistence });

// Use the client
await client.whenSynced;
client.tables.recordings.upsert({
	id: '1',
	title: 'Meeting notes',
	transcript: '...',
});
const recordings = client.tables.recordings.getAllValid();
```

Each workspace has:

- **id**: Locally-scoped identifier (e.g., `epicenter.whispering`, `epicenter.crm`)
- **name**: Display name shown in UI (defaults to humanized id)
- **tables**: Schema definition for typed tables
- **kv**: Schema definition for key-value store

### Workspace ID Format

The `id` is locally-scoped, not a GUID:

| Context             | Example                                       |
| ------------------- | --------------------------------------------- |
| Local (no sync)     | `epicenter.whispering`                        |
| Relay (no auth)     | `epicenter.crm`                               |
| Y-Sweet (with auth) | Server combines user ID for global uniqueness |

## The Epoch Parameter

The `epoch` determines which Workspace Doc to connect to.

**CRDT Safety**: The Head Doc uses a per-client MAX pattern to handle concurrent
epoch bumps safely. Each client writes their proposal to their own key; `getEpoch()`
returns `max()` of all proposals. See `../docs/README.md` for details.

```typescript
// New workspace or prototyping (epoch defaults to 0)
const client = createClient(definition.id)
	.withDefinition(definition)
	.withExtensions({ sqlite });

// Specific epoch (from Head Doc)
const head = createHeadDoc({ workspaceId: definition.id });
const epoch = head.getEpoch(); // e.g., 2
const client = createClient(definition.id, { epoch })
	.withDefinition(definition)
	.withExtensions({ sqlite });

// Migration: connect to multiple epochs
const oldClient = createClient(definition.id, { epoch: 1 })
	.withDefinition(definition)
	.withExtensions({});
const newClient = createClient(definition.id, { epoch: 2 })
	.withDefinition(definition)
	.withExtensions({});
// Migrate data from old to new...
```

See `../docs/README.md` for the full three-document architecture.

## What Happens in `createClient()`

When you call `createClient(workspaceId, { epoch }).withDefinition(definition).withExtensions({...})`:

```
1. Normalize definition (if minimal input)
   └── Apply defaults for name, icon, description

2. Create Workspace Doc at {id}-{epoch}
   └── Y.Doc with guid = "abc123xyz789012-0"
   └── Contains DATA ONLY (rows, kv values)

3. Create table and KV helpers
   └── Typed CRUD operations backed by Y.Doc

4. Run extension factories
   └── SQLite, persistence, sync, etc.

5. Return WorkspaceClient
   └── Ready to use!
```

**Key design decision**: The Y.Doc contains only data (table rows, kv values). The definition is static and comes from code or a `definition.json` file.

## Writing Functions

Write regular functions that use your client:

```typescript
const client = createClient(blogWorkspace.id)
	.withDefinition(blogWorkspace)
	.withExtensions({ sqlite, persistence });

function createPost(title: string) {
	const id = generateId();
	client.tables.posts.upsert({ id, title, published: false });
	return { id };
}

function publishPost(id: string) {
	client.tables.posts.update({ id, published: true });
}

function getPublishedPosts() {
	return client.tables.posts.filter((p) => p.published);
}

// Expose via HTTP, MCP, CLI however you want
app.post('/posts', (req) => createPost(req.body.title));
app.put('/posts/:id/publish', (req) => publishPost(req.params.id));
app.get('/posts', () => getPublishedPosts());
```

## Client Properties

```typescript
const client = createClient(blogWorkspace.id)
	.withDefinition(blogWorkspace)
	.withExtensions({ sqlite, persistence });

client.id;            // Workspace ID (e.g., 'epicenter.blog')
client.name;          // Display name (e.g., 'Blog')
client.tables;        // YJS-backed table operations
client.kv;            // Key-value store
client.extensions;    // Extension exports
client.ydoc;          // Underlying YJS document (Workspace Doc)
client.whenSynced;    // Promise that resolves when extensions are ready

await client.destroy();           // Cleanup resources
await using client = ...;         // Auto-cleanup with dispose
```

## Full Flow with Head Doc

For multi-user apps with epoch migrations:

```typescript
// 1. Get epoch from Head Doc
const head = createHeadDoc({ workspaceId: 'abc123xyz789012' });
await syncProvider.connect(head.ydoc);
const epoch = head.getEpoch();

// 2. Define workspace (can be done once, reused)
const blogWorkspace = defineWorkspace({
	id: 'abc123xyz789012',
	tables: { posts: { id: id(), title: text() } },
	kv: {},
});

// 3. Create client at that epoch
const client = createClient(blogWorkspace.id, { epoch })
	.withDefinition(blogWorkspace)
	.withExtensions({ sqlite, persistence });

// 4. Subscribe to epoch changes (optional)
head.observeEpoch(async (newEpoch) => {
	await client.destroy();
	const newClient = createClient(blogWorkspace.id, { epoch: newEpoch })
		.withDefinition(blogWorkspace)
		.withExtensions({ sqlite, persistence });
	// Update your app's reference to newClient
});
```

## Creating Servers

Use `createServer` to expose workspace clients over HTTP:

```typescript
import { createServer } from '@epicenter/hq';

// Single workspace
const server = createServer(blogClient, { port: 3913 });

// Multiple workspaces (array - IDs come from workspace definitions)
const server = createServer([blogClient, authClient], { port: 3913 });

// Start and manage lifecycle
server.start();
await server.destroy(); // Cleanup all clients
```

Routes are automatically namespaced by workspace ID:

- `/workspaces/blog/tables/posts`
- `/workspaces/auth/tables/users`

## Cross-Workspace Communication

Use regular JavaScript imports for dependencies:

```typescript
// auth-client.ts
export const authClient = createClient(authWorkspace.id)
	.withDefinition(authWorkspace)
	.withExtensions({ sqlite, persistence });

// blog-client.ts
import { authClient } from './auth-client';

// Use authClient in your functions
function createPost(title: string, userId: string) {
	const user = authClient.tables.users.get({ id: userId });
	if (user.status !== 'valid') throw new Error('Invalid user');

	const id = generateId();
	blogClient.tables.posts.upsert({ id, title, authorId: userId });
	return { id };
}
```

No magic dependency injection. Just regular JS imports.

## Sequential Script Execution

Multiple scripts can safely run using `await using`:

```typescript
// Script 1: Import data
{
	await using client = createClient(blogWorkspace.id)
		.withDefinition(blogWorkspace)
		.withExtensions({ sqlite, persistence });

	client.tables.posts.upsert({ id: '1', title: 'Hello' });
	// Auto-disposed when block exits
}

// Script 2: Process data (runs after Script 1)
{
	await using client = createClient(blogWorkspace.id)
		.withDefinition(blogWorkspace)
		.withExtensions({ sqlite, persistence });

	const posts = client.tables.posts.getAllValid();
	// Auto-disposed when block exits
}
```

## Migration Example

Same workspace definition, different epochs:

```typescript
const definition = defineWorkspace({
	id: 'abc123xyz789012',
	tables: { posts: { id: id(), title: text(), content: text() } },
	kv: {},
});

// Connect to old and new epochs
const oldClient = createClient(definition.id, { epoch: 1 })
	.withDefinition(definition)
	.withExtensions({});
const newClient = createClient(definition.id, { epoch: 2 })
	.withDefinition(definition)
	.withExtensions({});

// Migrate data
for (const post of oldClient.tables.posts.getAllValid()) {
	newClient.tables.posts.upsert(migratePost(post));
}

// Update Head Doc to point to new epoch
const head = createHeadDoc({ workspaceId: definition.id });
// Use bumpEpoch() for safe concurrent migrations
// Use setOwnEpoch() to set to a specific epoch (≤ global epoch)
head.bumpEpoch(); // Safe: computes max + 1
// OR: head.setOwnEpoch(2);  // Sets own epoch to 2 (if ≤ global)

// Cleanup
await oldClient.destroy();
await newClient.destroy();
```

## Storage Architecture

The workspace data is stored separately from the definition:

```
{appLocalDataDir}/
├── registry.yjs                    # Index of all workspace IDs
└── workspaces/
    └── {workspace-guid}/
        │
        │   # Static definition (not in Y.Doc)
        ├── definition.json         # WorkspaceDefinition (name, tables, kv)
        │
        │   # Epoch management
        ├── head.yjs                # Current epoch number
        │
        │   # Data storage (Y.Doc per epoch, DATA ONLY)
        ├── 0.yjs                   # Epoch 0 data (rows + kv values)
        └── 1.yjs                   # Epoch 1 (after migration)
```

**Key principle**: Y.Doc contains only data. Definition is static JSON.
