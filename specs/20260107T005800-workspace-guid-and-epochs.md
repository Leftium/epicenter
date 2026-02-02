# Workspace GUID and Epoch System

**Date**: 2026-01-07
**Status**: Draft
**Author**: AI-assisted

## Overview

Add a globally unique identifier (`guid`) and epoch-based versioning system to Epicenter workspaces. This enables:

1. **Stable workspace identity** that survives ownership transfers and renames
2. **Epoch transitions** for "fresh start" scenarios (schema migrations, corruption recovery)
3. **Multi-device sync** with a stable coordination anchor

## Motivation

### Current State

The current `WorkspaceSchema` has a single `id` field used as the YJS document GUID:

```typescript
// Current: id is both human-readable AND the YJS doc GUID
const ydoc = new Y.Doc({ guid: config.id }); // e.g., "blog"
```

This creates problems:

1. **Collision risk**: Two users both having `id: 'blog'` will sync incorrectly if they connect to the same server
2. **No workspace transfer**: Transferring ownership requires changing all references
3. **No fresh start**: Can't "reset" a workspace without losing all sync connections
4. **Coupled identity**: Human-readable slug is tied to system identity

### Desired State

Separate concerns:

- **`id`**: Human-readable slug for CLI, paths, URLs (can be renamed)
- **`guid`**: Stable system identity for sync, references, epochs (never changes)
- **Epochs**: Ability to "reset" data while preserving identity

## Research Findings

### No Established Pattern Exists

Extensive research across the YJS/CRDT ecosystem found:

| Project     | Pattern                | Coordination Approach |
| ----------- | ---------------------- | --------------------- |
| y-websocket | Plain `roomname`       | No coordination doc   |
| y-indexeddb | Plain `docName`        | No coordination doc   |
| y-sweet     | Plain `docId`          | No coordination doc   |
| Liveblocks  | Plain `roomId`         | Room metadata via API |
| Hocuspocus  | Plain `name`           | No coordination doc   |
| Gutenberg   | `ydoc.getMap('state')` | Map key inside doc    |
| AFFiNE      | `ydoc.getMap('meta')`  | Map key inside doc    |

**Key finding**: There is NO standard pattern for document ID suffixes like `:meta`, `:head`, or `:control`. Most projects use plain identifiers and either:

- Rely on CRDT convergence (no coordination needed)
- Use map keys inside a single document

**Implication**: We are defining our own convention. This spec documents that convention.

### CRDTs vs Epochs

Research also found that:

- **Pure CRDT systems** (YJS, Automerge) don't use epochs; they rely on state vector convergence
- **Epoch-based systems** (Spanner, CockroachDB, Nym) use epochs for coordination

Epicenter's epoch mechanism is a **higher-level coordination layer** on top of YJS CRDTs, designed for scenarios where you WANT to break from history (fresh start, schema migration).

## Design Decisions

### 1. GUID Format

Follow existing codebase patterns from `generateId()` and `createRichContentId()`:

```typescript
// Row IDs: 10 chars (sufficient for table-scoped uniqueness)
const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10);

// GUIDs: 15 chars (sufficient for global uniqueness across millions of workspaces)
export type Guid = string & Brand<'Guid'>;

const guidNanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 15);

export function generateGuid(): Guid {
	return guidNanoid() as Guid; // e.g., "abc123xyz789012"
}
```

### 2. Document Structure

The GUID alone is reserved for future coordination document. Numbered suffixes are data epochs:

```
abc123xyz789012       <- Reserved for future coordination doc
abc123xyz789012-0     <- Data doc, epoch 0
abc123xyz789012-1     <- Data doc, epoch 1
abc123xyz789012-2     <- Data doc, epoch 2
```

**Note**: Hyphen (`-`) is used as the epoch delimiter because y-sweet only allows alphanumeric characters, hyphens, and underscores in document IDs. Colons are NOT allowed.

**Why GUID alone for coordination?**

- The GUID IS the stable identifier; it makes sense that connecting to it gives you coordination info
- Data epochs are the "versioned" part, so they get the suffix
- Avoids bikeshedding on "meta" vs "head" vs "control"

### 3. Minimal Coordination Document

The coordination document contains exactly one field:

```typescript
// Y.Map contents of coordination doc
{
	epoch: number; // Current epoch to connect to
}
```

That's it. One field.

**Why so minimal?**

- Everything else is optional (audit info, pending state)
- The protocol works with just the epoch number
- Can add fields later if needed

**Why no `pending` field?**

- CRDTs handle unsync'd changes automatically
- Clients don't need to "prepare" for transitions
- `pending` would be for UX signaling only, not correctness
- Can add later if UX need emerges

### 4. Schema Changes

```typescript
export type WorkspaceSchema<
	TId extends string = string,
	TTablesSchema extends TablesSchema = TablesSchema,
	TKvSchema extends KvSchema = KvSchema,
> = {
	guid: string; // NEW: Stable identity (e.g., "abc123xyz789012")
	id: TId; // Human-readable slug (e.g., "blog")
	name: string; // Display name (e.g., "My Travel Blog")
	description?: string;
	tables: TTablesSchema;
	kv: TKvSchema;
};
```

## Architecture

### Document Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│  COORDINATION DOCUMENT (future)                              │
│  GUID: "abc123xyz789012"                                     │
│                                                              │
│  Y.Map contents:                                            │
│    epoch: 2                                                 │
│                                                              │
│  Purpose: Tells clients which data epoch to connect to      │
│  Lifetime: Permanent, never reset                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ epoch = 2
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  DATA DOCUMENT (current epoch)                              │
│  GUID: "abc123xyz789012-2"                                   │
│                                                              │
│  Y.Map contents:                                            │
│    tables: { posts: {...}, users: {...} }                   │
│    kv: { theme: 'dark', ... }                               │
│                                                              │
│  Purpose: Actual workspace data                             │
│  Lifetime: Until next epoch transition                      │
└─────────────────────────────────────────────────────────────┘
```

### Client Connection Flow

```
┌─────────────────────────────────────────────────────────────┐
│  1. Client starts with GUID: "abc123xyz789012"              │
│                                                              │
│  2. Connect to coordination doc: "abc123xyz789012" (future) │
│     → Read epoch: 2                                         │
│     → Subscribe to changes                                  │
│                                                              │
│  3. Connect to data doc: "abc123xyz789012-2"                │
│     → Load tables, kv                                       │
│     → Start syncing                                         │
│                                                              │
│  4. If coordination doc changes (epoch → 3):                │
│     → Disconnect from "abc123xyz789012-2"                   │
│     → Connect to "abc123xyz789012-3"                        │
│     → Continue with new data                                │
└─────────────────────────────────────────────────────────────┘
```

## Epoch Transition Protocol

### Prerequisites

- All clients connected to coordination doc (always)
- All clients connected to current data epoch

### Step-by-Step

```
STEP 1: Initiator takes snapshot
────────────────────────────────
Initiator captures current state of epoch N:
  const snapshot = Y.encodeStateAsUpdate(currentDataDoc);

STEP 2: Initiator creates new data doc
──────────────────────────────────────
Initiator creates epoch N+1 with snapshot:
  const newDataDoc = new Y.Doc({ guid: `${guid}-${epoch + 1}` });
  Y.applyUpdate(newDataDoc, snapshot);

STEP 3: Initiator bumps epoch (THE ATOMIC SWITCH)
─────────────────────────────────────────────────
Initiator writes to coordination doc:
  coordDoc.getMap('state').set('epoch', epoch + 1);

STEP 4: Other clients see change
────────────────────────────────
Via YJS sync, all clients receive epoch update.
Each client:
  1. Disconnects from old data doc
  2. Connects to new data doc
  3. YJS syncs any local changes to new doc
```

### Why This Is Safe

| Concern                             | How It's Handled                                   |
| ----------------------------------- | -------------------------------------------------- |
| Client has unsync'd changes         | Local YJS state syncs to new epoch on connect      |
| Multiple simultaneous bump attempts | YJS CRDT on coordination doc; one value wins       |
| Client offline during transition    | Reads coordination doc on reconnect                |
| Initiator crashes mid-transition    | Other client can retry; CRDT handles partial state |

The key insight: **Other clients don't copy data.** The initiator seeds the new epoch. Others just connect and let CRDT merge any differences.

## Implementation Plan

### Phase 1: Core Types and GUID Generation

- [x] **1.1** Add `Guid` branded type to `core/schema/fields/id.ts`
- [x] **1.2** Add `generateGuid()` function (15-char alphanumeric, no prefix)
- [x] **1.3** Update `WorkspaceSchema` type to include `guid` field
- [x] **1.4** Export new types from `core/schema/index.ts`

### Phase 2: Coordination Document

- [ ] **2.1** Create `core/coordination/coordination-doc.ts`
- [ ] **2.2** Implement `createCoordinationDoc()` function
- [ ] **2.3** Implement `CoordinationHelper` with:
  - `getEpoch()`: Read current epoch
  - `setEpoch(n)`: Set epoch (for transitions)
  - `observeEpoch(cb)`: Watch for epoch changes
- [ ] **2.4** Add types for coordination doc state

### Phase 3: Workspace Client Updates

- [x] **3.1** Update `initializeWorkspace()` to use `{guid}-0` as YJS doc GUID (epoch 0, reserved namespace)
- [ ] **3.2** Add epoch change observer to handle transitions (deferred)
- [x] **3.3** Update `WorkspaceClient` type to expose `guid`
- [ ] **3.4** Implement `bumpEpoch()` method on client for initiating transitions (deferred)

### Phase 4: defineWorkspace Updates

- [x] **4.1** Update `defineWorkspace()` to require `guid` in config
- [x] **4.2** Add validation: `guid` must be a non-empty string
- [ ] **4.3** Update all example workspaces with GUIDs
- [ ] **4.4** Add migration helper for existing workspaces

### Phase 5: Provider Updates

- [ ] **5.1** Update persistence provider to handle coordination doc
- [ ] **5.2** Update SQLite provider to store epoch in metadata
- [ ] **5.3** Update WebSocket sync to connect to correct docs
- [ ] **5.4** Consider: Should old epoch data docs be garbage collected?

### Phase 6: Documentation and Tests

- [ ] **6.1** Update `packages/epicenter/README.md` with GUID/epoch docs
- [ ] **6.2** Add unit tests for coordination doc
- [ ] **6.3** Add integration tests for epoch transitions
- [ ] **6.4** Add multi-client epoch transition tests

## File Structure

```
packages/epicenter/src/
├── core/
│   ├── coordination/                    # NEW
│   │   ├── coordination-doc.ts          # Coordination doc implementation
│   │   ├── types.ts                     # CoordinationState type
│   │   └── index.ts                     # Barrel exports
│   ├── schema/
│   │   └── fields/
│   │       └── id.ts                    # Add Guid type, generateGuid()
│   └── workspace/
│       └── contract.ts                  # Update WorkspaceSchema
├── providers/
│   ├── persistence/
│   │   └── desktop.ts                   # Handle coordination doc
│   └── websocket-sync.ts                # Connect to correct epoch
└── index.shared.ts                      # Export Guid, generateGuid
```

## API Examples

### Defining a Workspace with GUID

```typescript
import { defineWorkspace, generateGuid, id, text } from '@epicenter/hq';

const blogWorkspace = defineWorkspace({
	guid: 'abc123xyz789012', // Stable forever (15 chars)
	id: 'blog', // Can be renamed
	name: 'My Blog',
	tables: {
		posts: { id: id(), title: text() },
	},
	kv: {},
});

// Or generate a new GUID
const newWorkspace = defineWorkspace({
	guid: generateGuid(), // "k7x9m2p4q8r1abc"
	id: 'notes',
	name: 'My Notes',
	// ...
});
```

### Accessing GUID and Epoch

```typescript
const client = await blogWorkspace
	.withProviders({ sqlite: sqliteProvider })
	.create();

console.log(client.guid); // "abc123xyz789012"
console.log(client.epoch); // 0 (initial epoch) - future feature
```

### Bumping Epoch (Fresh Start)

```typescript
// Initiator bumps epoch
await client.bumpEpoch({
	copyData: true, // Copy current data to new epoch
	reason: 'schema migration', // Optional, for audit
});

// All connected clients automatically switch to new epoch
```

### Observing Epoch Changes

```typescript
client.onEpochChange((newEpoch, oldEpoch) => {
	console.log(`Epoch changed: ${oldEpoch} → ${newEpoch}`);
	// Client automatically reconnects; this is just for UI updates
});
```

## Edge Cases

### New Workspace (No Existing Data)

1. `defineWorkspace()` with new GUID
2. Coordination doc created with `epoch: 0`
3. Data doc `{guid}-0` created empty
4. Normal operation proceeds

### Joining Existing Workspace

1. Client receives GUID (e.g., from invite link)
2. Connects to coordination doc, reads `epoch: 2`
3. Connects to `{guid}:2`
4. Syncs data via CRDT

### Offline Client Rejoins After Epoch Bump

1. Client was on epoch 1, goes offline
2. While offline, epoch bumped to 2
3. Client comes online, connects to coordination doc
4. Sees `epoch: 2`, connects to `{guid}-2`
5. Any local changes from epoch 1 are... lost? (See Open Questions)

### Multiple Simultaneous Bump Attempts

1. Client A tries to bump epoch 1 → 2
2. Client B tries to bump epoch 1 → 2
3. Both write to coordination doc
4. CRDT merge: one `epoch: 2` value wins
5. Both clients end up on epoch 2
6. Data from both snapshots merges via CRDT

## Open Questions

1. **What happens to unsync'd changes from old epochs?**
   - If client was offline on epoch 1 and comes back to epoch 2, their epoch 1 changes are orphaned
   - Options: (a) Accept data loss, (b) Merge into new epoch somehow, (c) Warn user
   - **Recommendation**: Accept this as expected behavior; document clearly

2. **Should old epoch data docs be garbage collected?**
   - `{guid}-0`, `{guid}-1` accumulate over time
   - Options: (a) Keep forever, (b) GC after N epochs, (c) Manual cleanup
   - **Recommendation**: Defer; keep for now, add GC later if needed

3. **Should `guid` be auto-generated if not provided?**
   - Makes `defineWorkspace()` simpler for new projects
   - But then where is GUID stored for persistence?
   - **Recommendation**: Require explicit GUID; provide `generateGuid()` helper

4. **How to handle `id` renames?**
   - User renames `id: 'blog'` to `id: 'travel-blog'`
   - File paths change, but GUID stays same
   - Need migration for path-based providers
   - **Recommendation**: Defer; handle in separate spec

## Success Criteria

- [ ] `WorkspaceSchema` includes `guid` field
- [ ] `generateGuid()` produces valid GUIDs matching pattern
- [ ] Coordination doc created and synced correctly
- [ ] Data doc uses `{guid}-{epoch}` format
- [ ] Epoch transitions work with multiple clients
- [ ] Offline clients reconnect to correct epoch
- [ ] All existing tests pass with updated schema
- [ ] Documentation covers GUID and epoch concepts

## References

- `packages/epicenter/src/core/workspace/contract.ts` - Current WorkspaceSchema
- `packages/epicenter/src/core/schema/fields/id.ts` - Existing ID generation pattern
- `packages/epicenter/src/providers/websocket-sync.ts` - Sync provider to update
- Research: Librarian agent findings on YJS/CRDT coordination patterns
