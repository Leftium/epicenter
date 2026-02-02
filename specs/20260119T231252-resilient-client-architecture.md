# Resilient Client Architecture

**Status**: Implemented (Phase 1 + Phase 4 App Integration)  
**Created**: 2026-01-19  
**Updated**: 2026-01-20

## Summary

Redesign the workspace client initialization to:

1. Fix order-of-operations bugs (persistence must load BEFORE definition merge)
2. Remove external file dependencies (no more `readDefinition()` in route loaders)
3. Introduce a fluent API that mirrors the natural Y.Doc hierarchy (Registry → Head → Client)
4. Support two modes: dynamic schema (Epicenter app) and static schema (programmatic apps)
5. **Safe epoch migrations**: Prepare new epoch data BEFORE bumping (prepare-then-bump protocol)
6. **Explicit epoch change handling**: Notify users when epoch changes, let them choose when to reload

## The Three-Document Hierarchy

Epicenter uses three Y.Doc types with strict dependencies:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         Y.DOC DEPENDENCY CHAIN                                   │
│                                                                                  │
│   REGISTRY                 HEAD DOC                 WORKSPACE CLIENT             │
│   Y.Doc #1                 Y.Doc #2                 Y.Doc #3                     │
│                                                                                  │
│   ┌──────────────┐        ┌──────────────┐        ┌──────────────────────┐      │
│   │              │        │              │        │                      │      │
│   │  "Which      │───────▶│  "What       │───────▶│  "The actual         │      │
│   │   workspaces │        │   epoch?"    │        │   data"              │      │
│   │   exist?"    │        │              │        │                      │      │
│   │              │        │              │        │                      │      │
│   └──────────────┘        └──────────────┘        └──────────────────────┘      │
│                                                                                  │
│   File: registry.yjs      File: head.yjs          File: workspace.yjs           │
│   Guid: "local"           Guid: {workspaceId}     Guid: {workspaceId}-{epoch}   │
│                                                                                  │
│   ─────────────────────────────────────────────────────────────────────────────  │
│                                                                                  │
│   Provides:               Needs: workspaceId      Needs: workspaceId + epoch    │
│   - workspaceIds          Provides:               Provides:                      │
│                           - epoch                 - definition                   │
│                           - (latent workspaceId)  - tables                       │
│                                                   - kv                           │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Key insight**: You cannot create the Head Doc without a workspaceId (from Registry), and you cannot create the Workspace Client without an epoch (from Head Doc). This natural hierarchy suggests a fluent/chaining API.

## Current Problems

### Problem 1: Order-of-Operations Bug

```
Current Flow:
1. createClient() called with definition
2. mergeDefinitionIntoYDoc() sets name = "My Blog"  ← Happens FIRST
3. Persistence capability starts
4. whenSynced: Y.applyUpdate(ydoc, savedState)      ← Disk state loaded SECOND
5. CRDT merge: "Blog" from disk overwrites "My Blog"
6. User sees "Blog" instead of "My Blog"
```

The definition is merged BEFORE persistence loads, so CRDT semantics let old disk values win.

### Problem 2: External File Dependency

```typescript
// Route loader REQUIRES definition.json to exist
const definition = await readDefinition(workspaceId, epoch);
if (!definition) error(404); // ← Breaks if JSON deleted

const client = createWorkspaceClient(definition, epoch);
```

Chicken-and-egg: `definition.json` is written by persistence, but persistence only runs after `createClient()`.

### Problem 3: No Self-Healing

If `definition.json` is deleted but `workspace.yjs` exists, the app breaks. The Y.Doc (source of truth) is fine, but the JSON mirror (debug output) being missing causes a 404.

## Proposed Architecture

### Core Principle

**Single `whenSynced` promise that does operations in the correct ORDER:**

```
whenSynced = (async () => {
  // 1. LOAD from disk first
  const savedState = await readFile(workspaceYjsPath);
  Y.applyUpdate(ydoc, savedState);

  // 2. THEN merge definition (now code changes win as "last writer")
  if (needsDefinitionMerge) {
    mergeDefinitionIntoYDoc(definitionMap, definition);
  }

  // 3. THEN create helpers
  tables = createTables(ydoc, ...);
  kv = createKv(ydoc, ...);

  // 4. THEN write JSON mirrors (debug output)
  await saveDefinitionJson();
  await saveKvJson();
})();
```

**We don't need separate `whenLoaded` vs `whenReady` promises.** We just need to do things in the right order inside ONE `whenSynced`.

### Fluent API: Registry → Head → Client

The API mirrors the Y.Doc hierarchy with method chaining:

```typescript
// Synchronous chain, await at the end
const client = registry.head(workspaceId).client();
await client.whenSynced;

// Now safe to use
client.tables.posts.upsert({...});
```

**How it works internally:**

```
registry.head(workspaceId)
  │
  │  Synchronous:
  │  - Validates hasWorkspace(workspaceId)
  │  - Creates HeadDoc with Y.Doc guid = workspaceId
  │  - Attaches persistence (starts loading head.yjs in background)
  │  - Returns HeadDoc immediately (with pending whenSynced)
  │
  └── Returns: HeadDoc


head.client(options?)
  │
  │  Synchronous:
  │  - Creates WorkspaceClient placeholder
  │  - Sets up whenSynced promise that:
  │      1. await head.whenSynced (need accurate epoch)
  │      2. epoch = options?.epoch ?? head.getEpoch()
  │      3. Create Y.Doc with guid = "{workspaceId}-{epoch}"
  │      4. Load workspace.yjs from disk
  │      5. Merge definition if provided
  │      6. Create table/kv helpers
  │      7. Write JSON mirrors
  │  - Returns WorkspaceClient immediately (with pending whenSynced)
  │
  └── Returns: WorkspaceClient
```

The chain is **synchronous**, but each step's `whenSynced` internally awaits its dependencies.

## Complete API Reference

### Registry (Y.Doc #1 - Singleton)

```
File: {appLocalDataDir}/registry.yjs
Guid: "local"
Scope: Personal (syncs across YOUR devices only)
```

```typescript
// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE LISTING
// ═══════════════════════════════════════════════════════════════════════════════

registry.getWorkspaceIds(): string[]
// Get all workspace IDs in the registry

registry.hasWorkspace(id: string): boolean
// Check if a workspace exists in the registry

registry.count(): number
// Count of workspaces

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

registry.addWorkspace(id: string): void
// Add a workspace to the registry

registry.removeWorkspace(id: string): void
// Remove a workspace from the registry (does NOT delete files)

// ═══════════════════════════════════════════════════════════════════════════════
// OBSERVATION
// ═══════════════════════════════════════════════════════════════════════════════

registry.observe(callback): () => void
// Watch for workspace add/remove events
// callback receives: { added: string[], removed: string[] }
// Returns: unsubscribe function

// ═══════════════════════════════════════════════════════════════════════════════
// BRIDGE TO HEAD DOC (creates Y.Doc #2)
// ═══════════════════════════════════════════════════════════════════════════════

registry.head(workspaceId: string): HeadDoc
// Get a HeadDoc for the given workspace
// - Validates workspace exists (throws if not)
// - Creates Head Y.Doc with persistence
// - Returns HeadDoc with pending whenSynced
// - workspaceId becomes "latent" (remembered by HeadDoc)

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

registry.whenSynced: Promise<void>
// Resolves when registry.yjs is loaded from disk

registry.destroy(): Promise<void>
// Cleanup resources
```

### Head Doc (Y.Doc #2 - Per Workspace)

```
File: {appLocalDataDir}/workspaces/{workspaceId}/head.yjs
Guid: {workspaceId}
Scope: Shared (syncs with all collaborators)
```

```typescript
// ═══════════════════════════════════════════════════════════════════════════════
// IDENTITY (latent from registry.head() call)
// ═══════════════════════════════════════════════════════════════════════════════

head.workspaceId: string
// The workspace ID this head belongs to (set during creation)

// ═══════════════════════════════════════════════════════════════════════════════
// EPOCH READING
// ═══════════════════════════════════════════════════════════════════════════════

head.getEpoch(): number
// Get current epoch (max of all client proposals)
// Uses CRDT-safe per-client MAX pattern

head.getOwnEpoch(): number
// Get THIS client's epoch proposal (may differ from getEpoch())

head.getEpochProposals(): Map<string, number>
// Get all client proposals (for debugging)
// Map of clientId → epoch

// ═══════════════════════════════════════════════════════════════════════════════
// EPOCH WRITING
// ═══════════════════════════════════════════════════════════════════════════════

head.bumpEpoch(): number
// Increment to next epoch (returns new epoch)
// CRDT-safe: concurrent bumps converge to same value

head.setOwnEpoch(epoch: number): number
// Set own epoch to specific value (clamped to current max)
// For time travel / rollback UI
// Returns actual epoch set

// ═══════════════════════════════════════════════════════════════════════════════
// OBSERVATION
// ═══════════════════════════════════════════════════════════════════════════════

head.observeEpoch(callback): () => void
// Watch for epoch changes
// callback receives: (newEpoch: number)
// Returns: unsubscribe function

// ═══════════════════════════════════════════════════════════════════════════════
// BRIDGE TO WORKSPACE CLIENT (creates Y.Doc #3)
// ═══════════════════════════════════════════════════════════════════════════════

head.client(options?): WorkspaceClient
// Create a WorkspaceClient for this workspace
// Options:
//   epoch?: number - Override epoch (default: head.getEpoch())
//   capabilities?: {...} - Override default capabilities
//
// - Uses latent workspaceId from head
// - Uses epoch from head.getEpoch() unless overridden
// - Returns WorkspaceClient with pending whenSynced
// - whenSynced internally awaits head.whenSynced first

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

head.whenSynced: Promise<void>
// Resolves when head.yjs is loaded from disk

head.destroy(): Promise<void>
// Cleanup resources
```

### Workspace Client (Y.Doc #3 - Per Workspace + Epoch)

```
File: {appLocalDataDir}/workspaces/{workspaceId}/{epoch}/workspace.yjs
Guid: {workspaceId}-{epoch}
Scope: Shared (syncs with all collaborators)
```

```typescript
// ═══════════════════════════════════════════════════════════════════════════════
// IDENTITY
// ═══════════════════════════════════════════════════════════════════════════════

client.id: string
// Workspace ID

client.epoch: number
// Epoch this client is connected to

// ═══════════════════════════════════════════════════════════════════════════════
// DEFINITION (from Y.Map('definition'))
// ═══════════════════════════════════════════════════════════════════════════════

client.name: string
// Workspace name (live getter from Y.Doc)

client.icon: IconDefinition | null
// Workspace icon (live getter from Y.Doc)

client.getDefinition(): WorkspaceDefinition
// Read full definition from Y.Doc

client.setName(name: string): void
// Update workspace name

client.setIcon(icon: IconDefinition | null): void
// Update workspace icon

client.mergeDefinition(definition: Partial<WorkspaceDefinition>): void
// Merge definition updates into Y.Doc
// For dynamic schema updates (add tables, modify fields, etc.)

// ═══════════════════════════════════════════════════════════════════════════════
// DATA ACCESS
// ═══════════════════════════════════════════════════════════════════════════════

client.tables: Tables<T>
// Table helpers (typed per schema)

client.kv: Kv<T>
// KV helpers (typed per schema)

// ═══════════════════════════════════════════════════════════════════════════════
// ADVANCED
// ═══════════════════════════════════════════════════════════════════════════════

client.ydoc: Y.Doc
// Raw Y.Doc access

client.definitionMap: Y.Map
// Raw definition map access

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

client.whenSynced: Promise<void>
// Resolves when:
// 1. head.whenSynced completed (epoch is accurate)
// 2. workspace.yjs loaded from disk
// 3. Definition merged (if provided)
// 4. Table/kv helpers created
// 5. JSON mirrors written

client.destroy(): Promise<void>
// Cleanup resources
```

## Two Modes of Operation

### Mode 1: Dynamic Schema (Epicenter App)

User creates workspaces through UI. Schema lives in Y.Doc and is discovered, not provided.

**Use `createDynamicClient()`** - only needs workspace ID, schema comes from Y.Doc.

```typescript
import { createDynamicClient } from '@epicenter/hq';

// Load existing workspace - schema comes from Y.Doc
const client = createDynamicClient('my-workspace', {
	epoch,
	capabilities: { persistence },
});
await client.whenSynced;

// Definition already exists in Y.Doc
console.log(client.name); // "My Workspace"
```

Or via the fluent API (in Epicenter app):

```typescript
// Fluent chain - uses createDynamicClient internally
const client = registry.head('my-workspace').client();
await client.whenSynced;

// Time travel to old epoch
const oldClient = registry.head('my-workspace').client({ epoch: 2 });
await oldClient.whenSynced;
```

### Mode 2: Static Schema (Programmatic Apps / Libraries)

Developer defines schema in code. Schema is fixed at compile time.

**Use `createClient()`** - requires full `WorkspaceDefinition` (id, name, tables, kv).

```typescript
import { createClient, defineWorkspace } from '@epicenter/hq';

const definition = defineWorkspace({
	id: 'my-app',
	tables: {
		posts: table({
			name: 'Posts',
			fields: { id: id(), title: text() },
		}),
	},
	kv: {},
});

// Create client with static definition - merges after persistence loads
const client = createClient(definition, {
	epoch: 0,
	capabilities: { persistence },
});
await client.whenSynced;

// Fully typed from definition
client.tables.posts.upsert({ id: '1', title: 'Hello' });
```

### Key Design Decision: Two Functions, Clear Types

Instead of one function with optional fields and a boolean flag, we have two separate functions:

| Function                         | Input                                                       | Schema Source            | Use Case                     |
| -------------------------------- | ----------------------------------------------------------- | ------------------------ | ---------------------------- |
| `createClient(definition, opts)` | Full `WorkspaceDefinition` (required: id, name, tables, kv) | Code (merged after load) | Whispering, libraries, tests |
| `createDynamicClient(id, opts)`  | Just workspace ID                                           | Y.Doc (nothing merged)   | Epicenter app                |

**Why two functions?**

- Clear types: `WorkspaceDefinition` requires all fields (name, tables, kv)
- No optional gymnastics or boolean flags like `seedDefinition`
- Each function has clear, typed inputs
- Impossible to misuse (can't accidentally pass partial definition to `createClient`)

### Where Each API Lives

```
packages/epicenter/           ← The library (@epicenter/hq)
├── createClient()            ← Static schema API (requires full definition)
├── createDynamicClient()     ← Dynamic schema API (only needs ID)
├── createHeadDoc()           ← Low-level Head Doc (exported)
├── createRegistryDoc()       ← Low-level Registry Doc (exported)
└── defineWorkspace()         ← Schema definition helper (exported)

apps/epicenter/               ← The Notion-like app
├── registry                  ← Singleton with fluent API (internal)
│   └── registry.head()       ← Creates HeadDoc
│       └── head.client()     ← Uses createDynamicClient internally
└── Uses fluent API throughout
```

## File Structure

```
{appLocalDataDir}/
├── registry.yjs                    ← Y.Doc #1 (singleton)
├── registry.json                   ← Debug mirror
│
└── workspaces/
    └── {workspaceId}/
        ├── head.yjs                ← Y.Doc #2 (per workspace)
        ├── head.json               ← Debug mirror
        │
        ├── 0/                      ← Epoch 0
        │   ├── workspace.yjs       ← Y.Doc #3
        │   ├── definition.json     ← Debug mirror
        │   └── kv.json             ← Debug mirror
        │
        └── 1/                      ← Epoch 1
            └── ...
```

## Implementation: The Fix

The fix is simple: inside `whenSynced`, do operations in the right order.

### Before (Broken)

```typescript
// In createClient() - SYNCHRONOUS
const ydoc = new Y.Doc({ guid: docId });
mergeDefinitionIntoYDoc(definitionMap, definition); // ← WRONG: Before load!
const tables = createTables(ydoc, definition.tables);

// In persistence.whenSynced - ASYNC
const savedState = await readFile(workspaceYjsPath);
Y.applyUpdate(ydoc, savedState); // ← Old values overwrite new ones
```

### After (Fixed)

```typescript
// Everything inside whenSynced, in correct order
whenSynced: (async () => {
	// 1. Wait for head if needed (to get accurate epoch)
	if (headDoc) await headDoc.whenSynced;

	// 2. LOAD from disk FIRST
	try {
		const savedState = await readFile(workspaceYjsPath);
		Y.applyUpdate(ydoc, savedState);
	} catch {
		// New workspace, no existing state
	}

	// 3. THEN merge definition (now we're the "last writer")
	if (seedDefinition) {
		mergeDefinitionIntoYDoc(definitionMap, seedDefinition);
	}

	// 4. THEN create helpers from final state
	const definition = readDefinitionFromYDoc(definitionMap);
	tables = createTables(ydoc, definition.tables);
	kv = createKv(ydoc, definition.kv);

	// 5. THEN write mirrors
	await saveDefinitionJson();
	await saveKvJson();
})();
```

## Usage Examples

### Loading an Existing Workspace (Epicenter App)

```typescript
// Route loader - simple!
export const load: LayoutLoad = async ({ params }) => {
	const client = registry.head(params.id).client();
	await client.whenSynced;

	return { client };
};
```

### Creating a New Workspace (Epicenter App)

```typescript
// In mutation
registry.addWorkspace('new-workspace');

const client = registry.head('new-workspace').client();
await client.whenSynced;

// Workspace is empty, set initial definition
client.mergeDefinition({
	name: 'My New Workspace',
	tables: {},
	kv: {},
});
```

### Time Travel (View Old Epoch)

```typescript
const head = registry.head('my-workspace');
await head.whenSynced;

console.log(`Current epoch: ${head.getEpoch()}`); // 5

// Load an older epoch (read-only view)
const oldClient = head.client({ epoch: 2 });
await oldClient.whenSynced;
```

### Static Schema App (Library Usage)

```typescript
import { createClient, defineWorkspace, text, number } from '@epicenter/hq';

const definition = defineWorkspace({
	id: 'my-app',
	name: 'My App',
	tables: {
		products: {
			name: 'Products',
			fields: {
				id: text(),
				name: text(),
				price: number(),
			},
		},
	},
	kv: {},
});

const client = createClient(definition, {
	epoch: 0,
	capabilities: { persistence: indexedDbPersistence },
});
await client.whenSynced;

// Fully typed!
client.tables.products.upsert({ id: '1', name: 'Widget', price: 9.99 });
```

## Self-Healing Behavior

| Scenario                                          | Behavior                              |
| ------------------------------------------------- | ------------------------------------- |
| `workspace.yjs` exists, `definition.json` missing | Load Y.Doc → JSON regenerated         |
| `workspace.yjs` missing, new workspace            | Empty Y.Doc → use `mergeDefinition()` |
| `workspace.yjs` corrupted (empty)                 | Start fresh, use `mergeDefinition()`  |

**Key**: The Y.Doc is the source of truth. JSON files are debug mirrors that regenerate automatically.

## Safe Epoch Migration Protocol

### The Problem: Unsafe Epoch Bumping

The current `bumpEpoch()` implementation is CRDT-safe for concurrent bumps, but creates a **race condition** when used naively:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    UNSAFE MIGRATION (Race Condition)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Client A (Migrator)                 Client B (Observer)                   │
│   ───────────────────                 ───────────────────                   │
│                                                                             │
│   1. bumpEpoch() → epoch=1            (watching head.yjs)                   │
│      ↳ Announces new epoch                                                  │
│                                                                             │
│   2. createClient(epoch=1)            sees epoch change!                    │
│      ↳ Start creating new doc         createClient(epoch=1)                 │
│                                       ↳ Connects to epoch 1                 │
│                                                                             │
│   3. Migrating data...                sees EMPTY data! ❌                    │
│      ↳ Still copying rows             User confused: "Where's my data?"     │
│                                                                             │
│   4. Migration complete               (damage done)                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**The problem**: `bumpEpoch()` announces the new epoch BEFORE the data exists there. Other clients (including the same user on another device) immediately see the new epoch and connect to an empty or incomplete Y.Doc.

### The Solution: Prepare-Then-Bump

**CRITICAL RULE**: Always create and populate the new epoch's Y.Doc BEFORE calling `bumpEpoch()`.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     SAFE MIGRATION (Prepare-Then-Bump)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Client A (Migrator)                 Client B (Observer)                   │
│   ───────────────────                 ───────────────────                   │
│                                                                             │
│   1. newEpoch = getEpoch() + 1        (watching head.yjs, epoch=0)          │
│      ↳ Calculate target epoch                                               │
│                                                                             │
│   2. createClient(epoch=1)            still sees epoch=0                    │
│      ↳ Create new Y.Doc quietly       still using epoch=0 client            │
│                                                                             │
│   3. Migrate all data                 still sees epoch=0                    │
│      ↳ Copy rows from old to new      working normally                      │
│                                                                             │
│   4. await newClient.whenSynced       still sees epoch=0                    │
│      ↳ Ensure data is persisted       working normally                      │
│                                                                             │
│   5. bumpEpoch() → epoch=1            sees epoch change!                    │
│      ↳ NOW announce new epoch         createClient(epoch=1)                 │
│                                       ↳ Data already complete ✅             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Safe Migration Code Pattern

```typescript
/**
 * Safely migrate to a new epoch.
 *
 * IMPORTANT: This function creates the new epoch's data BEFORE bumping.
 * Other clients will only see the new epoch after data is ready.
 */
async function migrateToNewEpoch<T extends TableDefinitionMap>(
	head: HeadDoc,
	definition: WorkspaceDefinition<T>,
	options: {
		capabilities?: CapabilityFactories;
		migrate: (
			oldClient: WorkspaceClient<T>,
			newClient: WorkspaceClient<T>,
		) => Promise<void>;
	},
): Promise<{
	oldEpoch: number;
	newEpoch: number;
	newClient: WorkspaceClient<T>;
}> {
	const oldEpoch = head.getEpoch();
	const newEpoch = oldEpoch + 1;

	// 1. Create clients for BOTH epochs
	const oldClient = createClient(definition, {
		epoch: oldEpoch,
		capabilities: options.capabilities,
	});

	const newClient = createClient(definition, {
		epoch: newEpoch, // This Y.Doc doesn't exist yet - that's fine!
		capabilities: options.capabilities,
	});

	// 2. Wait for both to be ready
	await Promise.all([oldClient.whenSynced, newClient.whenSynced]);

	// 3. Run the migration (user-provided logic)
	await options.migrate(oldClient, newClient);

	// 4. Ensure new data is persisted
	// (whenSynced includes persistence, but be explicit)
	await newClient.whenSynced;

	// 5. NOW bump the epoch - data is ready!
	head.bumpEpoch();

	// 6. Cleanup old client
	await oldClient.destroy();

	return { oldEpoch, newEpoch, newClient };
}
```

### Migration Examples

#### Example 1: Schema Migration (Add New Field)

```typescript
const { newClient } = await migrateToNewEpoch(head, definition, {
	capabilities: { persistence },
	migrate: async (oldClient, newClient) => {
		// Copy all posts, adding the new 'status' field
		for (const post of oldClient.tables.posts.getAllValid()) {
			newClient.tables.posts.upsert({
				...post,
				status: 'published', // New field with default value
			});
		}
	},
});
```

#### Example 2: Y.Doc Compaction (Reduce CRDT Bloat)

```typescript
const { newClient } = await migrateToNewEpoch(head, definition, {
	capabilities: { persistence },
	migrate: async (oldClient, newClient) => {
		// Simply copy current state - new Y.Doc has no history/tombstones
		for (const table of Object.keys(oldClient.tables)) {
			for (const row of oldClient.tables[table].getAllValid()) {
				newClient.tables[table].upsert(row);
			}
		}

		// Copy KV values
		for (const [key, value] of Object.entries(oldClient.kv.getAll())) {
			newClient.kv.set(key, value);
		}
	},
});
```

#### Example 3: Data Transformation (Rename Field)

```typescript
const { newClient } = await migrateToNewEpoch(head, definition, {
	capabilities: { persistence },
	migrate: async (oldClient, newClient) => {
		for (const post of oldClient.tables.posts.getAllValid()) {
			// Transform: 'body' → 'content'
			const { body, ...rest } = post;
			newClient.tables.posts.upsert({
				...rest,
				content: body, // Renamed field
			});
		}
	},
});
```

### Concurrent Migrations

**Q: What if two clients try to migrate simultaneously?**

A: CRDT handles this gracefully. Both clients:

1. Create epoch N+1 Y.Docs independently
2. Migrate data into their local epoch N+1
3. Call `bumpEpoch()` (both propose N+1, converge via MAX)
4. When Y.Docs sync, data merges via CRDT

The result is correct because:

- Both clients migrated the same source data
- CRDT merge is deterministic
- `bumpEpoch()` uses per-client MAX (no double-bump)

**Best practice**: For schema migrations with transformations, consider using `clientID = 0` during migration to make operations idempotent across clients. See Y.js migration patterns documentation.

## Epoch Change Notification

### The Problem: Silent Reconnection

When the epoch changes (due to migration on another device), the current client is suddenly pointing at stale data. Auto-reconnecting without user awareness can cause confusion or data loss if the user is mid-edit.

### The Solution: Explicit User Control (Option C)

**Design principle**: Notify the user when a new epoch is available. Let them decide when to reload.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    EPOCH CHANGE NOTIFICATION FLOW                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   1. Client A bumps epoch (after safe migration)                            │
│                                                                             │
│   2. Client B's head.observeEpoch() fires                                   │
│      ↳ newEpoch > currentEpoch detected                                     │
│                                                                             │
│   3. Show notification to user:                                             │
│      ┌─────────────────────────────────────────────────────────┐            │
│      │  ℹ️  New version available                               │            │
│      │                                                         │            │
│      │  The workspace data has been updated on another device. │            │
│      │                                                         │            │
│      │  [Reload Now]  [Later]                                  │            │
│      └─────────────────────────────────────────────────────────┘            │
│                                                                             │
│   4. User clicks "Reload Now"                                               │
│      ↳ await client.destroy()                                               │
│      ↳ newClient = createClient(def, { epoch: newEpoch })                   │
│      ↳ await newClient.whenSynced                                           │
│      ↳ Update app state                                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Implementation: Svelte Example

```svelte
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { toast } from '$lib/components/ui/toast';
	import { createClient, type WorkspaceClient } from '@epicenter/hq';

	let { definition, head, capabilities } = $props();

	let client: WorkspaceClient = $state(null!);
	let unsubscribeEpoch: (() => void) | null = null;

	onMount(async () => {
		// Initial client creation
		await head.whenSynced;
		client = createClient(definition, {
			epoch: head.getEpoch(),
			capabilities,
		});
		await client.whenSynced;

		// Watch for epoch changes from other devices
		unsubscribeEpoch = head.observeEpoch((newEpoch) => {
			if (newEpoch > client.epoch) {
				showEpochChangeNotification(newEpoch);
			}
		});
	});

	onDestroy(async () => {
		unsubscribeEpoch?.();
		await client?.destroy();
	});

	function showEpochChangeNotification(newEpoch: number) {
		toast.info({
			title: 'New version available',
			description: 'The workspace data has been updated on another device.',
			duration: Infinity, // Don't auto-dismiss
			action: {
				label: 'Reload Now',
				onClick: () => reloadToEpoch(newEpoch),
			},
		});
	}

	async function reloadToEpoch(newEpoch: number) {
		// Show loading state
		const oldClient = client;

		// Create new client at new epoch
		const newClient = createClient(definition, {
			epoch: newEpoch,
			capabilities,
		});
		await newClient.whenSynced;

		// Swap clients
		client = newClient;

		// Cleanup old client
		await oldClient.destroy();

		toast.success({ title: 'Reloaded to latest version' });
	}
</script>

{#if client}
	<WorkspaceView {client} />
{:else}
	<Loading />
{/if}
```

### Implementation: Reactive Store (Alternative)

For apps that need the client reference in multiple components:

```typescript
// lib/stores/workspace-client.svelte.ts
import {
	createClient,
	type WorkspaceClient,
	type HeadDoc,
} from '@epicenter/hq';

export function createWorkspaceStore(
	definition: WorkspaceDefinition,
	head: HeadDoc,
	capabilities: CapabilityFactories,
) {
	let client = $state<WorkspaceClient | null>(null);
	let pendingEpoch = $state<number | null>(null);
	let isReloading = $state(false);

	// Initialize
	$effect(() => {
		(async () => {
			await head.whenSynced;
			client = createClient(definition, {
				epoch: head.getEpoch(),
				capabilities,
			});
			await client.whenSynced;
		})();
	});

	// Watch for epoch changes
	$effect(() => {
		if (!client) return;

		const unsubscribe = head.observeEpoch((newEpoch) => {
			if (newEpoch > client!.epoch) {
				pendingEpoch = newEpoch;
			}
		});

		return unsubscribe;
	});

	async function reloadToLatest() {
		if (!pendingEpoch || !client) return;

		isReloading = true;
		const oldClient = client;
		const targetEpoch = pendingEpoch;

		try {
			const newClient = createClient(definition, {
				epoch: targetEpoch,
				capabilities,
			});
			await newClient.whenSynced;

			client = newClient;
			pendingEpoch = null;
			await oldClient.destroy();
		} finally {
			isReloading = false;
		}
	}

	return {
		get client() {
			return client;
		},
		get pendingEpoch() {
			return pendingEpoch;
		},
		get isReloading() {
			return isReloading;
		},
		get hasUpdate() {
			return pendingEpoch !== null;
		},
		reloadToLatest,
	};
}
```

Usage:

```svelte
<script>
	const workspace = createWorkspaceStore(definition, head, capabilities);
</script>

{#if workspace.hasUpdate}
	<Banner>
		New version available.
		<Button onclick={workspace.reloadToLatest} disabled={workspace.isReloading}>
			{workspace.isReloading ? 'Reloading...' : 'Reload'}
		</Button>
	</Banner>
{/if}

{#if workspace.client}
	<WorkspaceView client={workspace.client} />
{/if}
```

### Static Schema Apps (e.g., Whispering)

Even apps with static schemas should handle epoch notifications if they support multi-device sync:

```typescript
// Whispering initialization
const head = createHeadDoc({
	workspaceId: 'epicenter.whispering',
}).withProviders({ persistence: headPersistence });

await head.whenSynced;

let client = createClient(whisperingDefinition, {
	epoch: head.getEpoch(),
	capabilities: { persistence },
});

await client.whenSynced;

// Watch for epoch changes (another Whispering instance might migrate)
head.observeEpoch(async (newEpoch) => {
	if (newEpoch > client.epoch) {
		// For Whispering: auto-reload is acceptable since it's user-initiated
		// and data is less likely to be mid-edit
		await client.destroy();
		client = createClient(whisperingDefinition, {
			epoch: newEpoch,
			capabilities: { persistence },
		});
		await client.whenSynced;

		// Optionally notify user
		console.log(`Whispering upgraded to epoch ${newEpoch}`);
	}
});
```

### When to Use Each Pattern

| App Type                 | Epoch Change Handling        | Rationale                                                  |
| ------------------------ | ---------------------------- | ---------------------------------------------------------- |
| **Epicenter (main app)** | Notification + manual reload | Users may be mid-edit; explicit control prevents confusion |
| **Whispering**           | Notification or auto-reload  | Transcription data is append-only; less risk of conflict   |
| **CLI tools/scripts**    | Auto-reload or error         | Non-interactive; can restart cleanly                       |
| **Read-only views**      | Auto-reload                  | No edit state to lose                                      |

## Migration Path

### Phase 1: Fix Order in Existing Code

Move `mergeDefinitionIntoYDoc()` to after persistence load, inside `whenSynced`.

### Phase 2: Add Fluent API to Registry

```typescript
// Add to existing registry singleton
registry.head(workspaceId): HeadDoc
```

### Phase 3: Add client() to HeadDoc

```typescript
// Add to HeadDoc
head.client(options?): WorkspaceClient
```

### Phase 4: Update Route Loaders

```typescript
// Before
const definition = await readDefinition(workspaceId, epoch);
const client = createWorkspaceClient(definition, epoch);

// After
const client = registry.head(workspaceId).client();
await client.whenSynced;
```

### Phase 5: Remove `readDefinition()`

No longer needed - definition comes from Y.Doc.

## Summary

| Problem                  | Solution                                          |
| ------------------------ | ------------------------------------------------- |
| Order-of-operations bug  | Load from disk BEFORE merging definition          |
| External file dependency | Route loader uses Y.Doc, not JSON                 |
| No self-healing          | JSON mirrors regenerate from Y.Doc                |
| Awkward initialization   | Fluent API mirrors Y.Doc hierarchy                |
| Unsafe epoch bumping     | Prepare-then-bump protocol (data before announce) |
| Silent epoch changes     | Explicit notification + user-controlled reload    |

**Key insights**:

1. The chain `Registry → Head → Client` matches the Y.Doc dependency chain. Making the API mirror this structure makes the correct usage obvious and incorrect usage impossible.

2. **Never call `bumpEpoch()` until the new epoch's data is ready.** The safe migration protocol ensures other clients always see complete data when they detect an epoch change.

3. **Epoch changes should be explicit, not silent.** Users need to know when their view of the data is stale and be given control over when to reload.

## Todo

### Phase 1: Core Fixes ✅

- [x] Fix order-of-operations in `createClient()` (move merge after load)
- [x] Add `registry.head(workspaceId)` method
- [x] Add `head.client(options?)` method
- [x] Add `createDynamicClient()` for dynamic schema mode
- [x] Add `client.getDefinition()` method to read definition from Y.Doc

### Phase 2: Safe Migration

- [ ] Add `migrateToNewEpoch()` helper function to `@epicenter/hq`
- [ ] Document `bumpEpoch()` with warning about prepare-then-bump requirement
- [ ] Add migration examples to README

### Phase 3: Epoch Change Notification

- [ ] Implement epoch change notification in Epicenter app
- [ ] Create `createWorkspaceStore()` Svelte store for reactive client management
- [ ] Add toast/banner UI for epoch change notifications
- [ ] Implement `reloadToLatest()` functionality

### Phase 4: App Integration ✅

- [x] Update route loaders to use fluent API
- [x] Remove `readDefinition()` dependency (deprecated, fluent API reads from Y.Doc)
- [ ] Update Whispering to use HeadDoc for epoch management
- [ ] Add epoch change handling to Whispering

### Phase 5: Testing & Documentation

- [ ] Add tests for safe migration protocol
- [ ] Add tests for concurrent migration scenarios
- [ ] Add tests for epoch change notification flow
- [ ] Update package documentation
- [ ] Update Three-Doc Architecture README
