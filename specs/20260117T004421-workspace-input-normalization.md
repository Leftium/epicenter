# Workspace Input Normalization

## Problem

Two issues with the current architecture:

1. **Developer ergonomics**: `defineWorkspace` requires full metadata (name, icon, description) for every table. Developers building their own apps only need sync—they don't care about UI metadata.

2. **Definition storage**: The current branch stores `WorkspaceDefinition` inside the Y.Doc as CRDT state. This adds complexity and CRDT overhead for data that rarely changes (workspace name, table icons).

## Solution

1. **Two type shapes**: Minimal input for developers, full definition for storage/UI.
2. **Static definitions**: Definition lives in a JSON file, not in the Y.Doc.
3. **Y.Doc = data only**: Y.Doc contains table rows and kv values, nothing else.

## Storage Architecture

### Current (storing definition in Y.Doc)

```
~/Library/Application Support/com.tauri.dev/
├── registry.yjs
└── workspaces/
    └── {workspace-guid}/
        ├── head.yjs
        ├── 0.yjs           ← Contains data AND definition (CRDT state)
        └── 1.yjs
```

### Proposed (static definition file)

```
~/Library/Application Support/com.tauri.dev/
├── registry.yjs                    # Index of all workspace IDs
├── registry.json                   # Human-readable snapshot
└── workspaces/
    └── {workspace-id}/             # e.g., "epicenter.whispering"
        ├── definition.json         # ← Static workspace definition
        ├── head.yjs                # Current epoch tracker
        ├── head.json               # Snapshot
        ├── 0.yjs                   # Epoch 0: DATA ONLY (rows, kv values)
        ├── 0.json                  # Snapshot
        └── 1.yjs                   # Epoch 1 (after migration)
```

### Workspace ID Format

The `id` is a **locally-scoped identifier**, not a GUID:

| Context             | ID Format            | Example                            |
| ------------------- | -------------------- | ---------------------------------- |
| Local (no sync)     | `{namespace}.{name}` | `epicenter.whispering`             |
| Relay (no auth)     | Same as local        | `epicenter.crm`                    |
| Y-Sweet (with auth) | `{userId}/{localId}` | `user_abc123/epicenter.whispering` |

The relay server or Y-Sweet lobby combines user ID with local ID when needed for global uniqueness. Locally, developers use simple, readable IDs.

### Why `definition.json`?

| Name              | Meaning                                        | Verdict       |
| ----------------- | ---------------------------------------------- | ------------- |
| `definition.json` | Full `WorkspaceDefinition` (metadata + schema) | **Best fit**  |
| `schema.json`     | Implies just data schema, not metadata         | Too narrow    |
| `workspace.json`  | Generic, could be confused with data           | Ambiguous     |
| `config.json`     | Implies runtime settings                       | Wrong concept |

### What Goes Where

| File              | Contents                                                   | Editable By                 |
| ----------------- | ---------------------------------------------------------- | --------------------------- |
| `definition.json` | `WorkspaceDefinition` (id, name, tables with metadata, kv) | Epicenter UI, text editor   |
| `{epoch}.yjs`     | Table rows, kv values                                      | Y.Doc operations only       |
| `head.yjs`        | Current epoch number                                       | Migration system            |
| `registry.yjs`    | List of workspace IDs                                      | Workspace creation/deletion |

### Example `definition.json`

```json
{
	"id": "epicenter.whispering",
	"name": "Whispering",
	"tables": {
		"recordings": {
			"name": "Recordings",
			"icon": { "type": "emoji", "value": "🎙️" },
			"description": "Voice recordings and transcriptions",
			"fields": {
				"id": { "type": "id" },
				"title": { "type": "text" },
				"transcript": { "type": "text", "nullable": true }
			}
		}
	},
	"kv": {}
}
```

## Types

### FieldDefinitionMap

```typescript
type FieldDefinitionMap = Record<string, FieldDefinition>;
```

No transformation. Used as-is in both input and definition.

### TableInput

Minimal. Just fields.

```typescript
type TableInput = FieldDefinitionMap;

// Example
{ id: id(), title: text(), published: boolean() }
```

### TableDefinition

Full. Fields + metadata.

```typescript
type TableDefinition = {
	name: string; // humanize-string from key
	icon: Icon; // default: { type: 'emoji', value: '📄' }
	description: string; // default: ''
	fields: FieldDefinitionMap;
};
```

### WorkspaceInput

Minimal. ID + tables (fields only) + kv. No name.

```typescript
type WorkspaceInput = {
	id: string;
	tables: Record<string, TableInput>; // ALL tables must be minimal
	kv: Record<string, KvInput>;
};
```

### WorkspaceDefinition

Full. ID + name + tables + kv.

```typescript
type WorkspaceDefinition = {
	id: string;
	name: string; // humanize-string from id
	tables: Record<string, TableDefinition>;
	kv: Record<string, KvDefinition>;
};
```

## Function

Single function. Accepts input or definition. Returns definition.

```typescript
function defineWorkspace(
	input: WorkspaceInput | WorkspaceDefinition,
): WorkspaceDefinition;
```

### Detection

If `input.name` exists → already a definition → pass through.
Otherwise → normalize.

```typescript
function isWorkspaceDefinition(
	input: WorkspaceInput | WorkspaceDefinition,
): input is WorkspaceDefinition {
	return 'name' in input;
}
```

## Normalization Logic

### Table Normalization

```typescript
import humanizeString from 'humanize-string';

const DEFAULT_ICON = { type: 'emoji', value: '📄' } as const satisfies Icon;

function normalizeTable(key: string, input: TableInput): TableDefinition {
	return {
		name: humanizeString(key),
		icon: DEFAULT_ICON,
		description: '',
		fields: input,
	};
}
```

### Workspace Normalization

```typescript
function normalizeWorkspace(input: WorkspaceInput): WorkspaceDefinition {
	return {
		id: input.id,
		name: humanizeString(input.id),
		tables: Object.fromEntries(
			Object.entries(input.tables).map(([key, table]) => [
				key,
				normalizeTable(key, table),
			]),
		),
		kv: normalizeKv(input.kv),
	};
}
```

### Main Function

```typescript
function defineWorkspace(
	input: WorkspaceInput | WorkspaceDefinition,
): WorkspaceDefinition {
	if (isWorkspaceDefinition(input)) {
		return input;
	}
	return normalizeWorkspace(input);
}
```

## Examples

### Minimal Input

```typescript
const workspace = defineWorkspace({
	id: 'epicenter.whispering',
	tables: {
		recordings: { id: id(), title: text(), transcript: text() },
		transformations: { id: id(), name: text(), prompt: text() },
	},
	kv: {},
});
```

Output:

```typescript
{
  id: 'epicenter.whispering',
  name: 'Epicenter whispering',
  tables: {
    recordings: {
      name: 'Recordings',
      icon: { type: 'emoji', value: '📄' },
      description: '',
      fields: { id: id(), title: text(), transcript: text() },
    },
    transformations: {
      name: 'Transformations',
      icon: { type: 'emoji', value: '📄' },
      description: '',
      fields: { id: id(), name: text(), prompt: text() },
    },
  },
  kv: {},
}
```

### Full Definition (Pass-Through)

```typescript
const workspace = defineWorkspace({
	id: 'epicenter.whispering',
	name: 'Whispering',
	tables: {
		recordings: {
			name: 'Recordings',
			icon: { type: 'emoji', value: '🎙️' },
			description: 'Voice recordings',
			fields: { id: id(), title: text() },
		},
	},
	kv: {},
});
```

Returns unchanged.

## Dependencies

- `humanize-string` - Converts camelCase/kebab-case to human readable

```typescript
humanizeString('blogPosts'); // → 'Blog posts'
humanizeString('content-hub'); // → 'Content hub'
humanizeString('user_profile'); // → 'User profile'
```

## Type Summary

| Type                | Has `name`? | Tables shape                                      |
| ------------------- | ----------- | ------------------------------------------------- |
| WorkspaceInput      | No          | `Record<string, TableInput>` (fields only)        |
| WorkspaceDefinition | Yes         | `Record<string, TableDefinition>` (full metadata) |

| Type            | What it is                                  |
| --------------- | ------------------------------------------- |
| TableInput      | Just fields: `{ id: id(), title: text() }`  |
| TableDefinition | Full: `{ name, icon, description, fields }` |

**All-or-nothing rule**: A workspace is either entirely `WorkspaceInput` (all tables minimal) or entirely `WorkspaceDefinition` (all tables full). No mixing.

## Default Values

| Field             | Default Value                                            |
| ----------------- | -------------------------------------------------------- |
| Workspace name    | `humanizeString(id)`                                     |
| Table name        | `humanizeString(key)`                                    |
| Table icon        | `{ type: 'emoji', value: '📄' } as const satisfies Icon` |
| Table description | `''`                                                     |

## Implementation Plan

Implementation proceeds in dependency order: Part 1 → Part 3 → Part 2.

### Part 1: Remove definition from Y.Doc

First, stop storing metadata in Y.Doc. This simplifies the CRDT layer.

- [x] Stop storing `name`, `slug`, tables metadata in Y.Doc
- [x] Y.Doc only contains: `tables` map (rows) and `kv` map (values)
- [x] Definition comes from code (`defineWorkspace()`) or file (`definition.json`)
- [x] Remove `client.definition` from public API (already done on current branch)
- [x] Remove live CRDT getters for `name`/`slug` (definition is now static)

### Part 3: SDK normalization function

Second, build the normalization layer. This lets `defineWorkspace()` accept minimal input and expand it to full definitions. Required before Part 2 because the app needs to normalize user-created workspaces.

- [x] Add `humanize-string` dependency
- [x] Implement `isWorkspaceDefinition()` type guard
- [x] Implement `isTableDefinition()` type guard
- [x] Implement `normalizeTable()` function
- [x] Implement `normalizeWorkspace()` function
- [x] Update `defineWorkspace()` to accept both input and definition
- [x] Export types: `WorkspaceInput`, `WorkspaceDefinition`, `TableInput`, `TableDefinition`

### Part 2: Epicenter app reads/writes `definition.json`

Third, wire up the Epicenter app to use static definition files. Depends on Part 3 for normalization.

- [x] When user creates workspace in UI → write `definition.json`
- [ ] When user edits name/icon in UI → update `definition.json` _(stubbed - future work)_
- [x] App reads `definition.json` on load to know workspace structure
- [x] SDK normalizes `WorkspaceInput` → `WorkspaceDefinition` at runtime

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Developer Code                         Epicenter App                        │
│                                                                             │
│  defineWorkspace({                      User creates workspace in UI        │
│    id: 'epicenter.whispering',          ─────────────────────────────       │
│    tables: {                                      │                         │
│      posts: { id: id(), title: text() } ←── OR ──→ definition.json         │
│    },                                             │                         │
│    kv: {}                                         ▼                         │
│  })                                     ┌─────────────────────┐             │
│       │                                 │ WorkspaceDefinition │             │
│       ▼                                 │ (full metadata)     │             │
│  ┌────────────┐                         └─────────────────────┘             │
│  │ normalize  │────────────────────────────────────┘                        │
│  └────────────┘                                                             │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        WorkspaceDefinition                           │   │
│  │  {                                                                   │   │
│  │    id: 'epicenter.whispering',                                       │   │
│  │    name: 'Epicenter whispering',     ← humanize-string default       │   │
│  │    tables: {                                                         │   │
│  │      recordings: {                                                   │   │
│  │        name: 'Recordings',           ← humanize-string default       │   │
│  │        icon: { type: 'emoji', value: '📄' },  ← default              │   │
│  │        description: '',              ← default                       │   │
│  │        fields: { id: id(), title: text() }                           │   │
│  │      }                                                               │   │
│  │    },                                                                │   │
│  │    kv: {}                                                            │   │
│  │  }                                                                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                           Y.Doc (data only)                          │   │
│  │                                                                      │   │
│  │   Y.Map('tables')                                                    │   │
│  │     └── recordings: Y.Map<rowId, Y.Map<field, value>>                │   │
│  │                                                                      │   │
│  │   Y.Map('kv')                                                        │   │
│  │     └── key: value                                                   │   │
│  │                                                                      │   │
│  │   NO definition/schema/metadata stored here                          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## File System Layout (Epicenter App)

```
~/Library/Application Support/com.tauri.dev/
├── registry.yjs                    # Index of all workspace IDs
├── registry.json                   # Human-readable snapshot
└── workspaces/
    ├── epicenter.whispering/       # Whispering workspace
    │   ├── definition.json
    │   ├── head.yjs
    │   ├── 0.yjs
    │   └── 0.json
    │
    └── epicenter.crm/              # CRM workspace
        │
        │   # Static definition (edited by UI or text editor)
        ├── definition.json
        │
        │   # Epoch management
        ├── head.yjs                # Current epoch number
        ├── head.json               # Snapshot
        │
        │   # Data storage (Y.Doc per epoch)
        ├── 0.yjs                   # Epoch 0 data (rows + kv values)
        ├── 0.json                  # Snapshot
        ├── 1.yjs                   # Epoch 1 (after migration)
        └── 1.json                  # Snapshot
```

## Key Decisions

1. **Definition is static**: No CRDT for metadata. Last-write-wins at file level is fine.
2. **Y.Doc = data only**: Simpler mental model, less CRDT overhead.
3. **`definition.json` is the source of truth**: Both SDK and Epicenter app read from it.
4. **Normalization happens at runtime**: SDK fills in defaults when loading.
5. **All-or-nothing**: Either ALL tables are minimal (WorkspaceInput) or ALL have full metadata (WorkspaceDefinition). No mixing.

---

## Review

### Summary of Changes

This refactor separates **workspace metadata** (definition) from **workspace data** (rows, kv values) by moving definitions out of Y.Doc into static JSON files.

### Commits (in implementation order)

| Commit    | Scope | Description                                                                                                     |
| --------- | ----- | --------------------------------------------------------------------------------------------------------------- |
| `9e82931` | SDK   | Add `humanize-string` dependency                                                                                |
| `e01c375` | SDK   | Add normalization types (`WorkspaceInput`, `TableInput`) and functions (`normalizeTable`, `normalizeWorkspace`) |
| `ea638c6` | SDK   | Export normalization types/functions from main index                                                            |
| `745640a` | SDK   | Update `defineWorkspace()` with function overloads to accept both minimal and full input                        |
| `ba16fc7` | SDK   | Remove definition storage from Y.Doc (removed `createDefinition`, CRDT getters)                                 |
| `61c614e` | App   | Add `definition-persistence.ts` with `readDefinition()`, `writeDefinition()`, `hasDefinition()`                 |
| `9c9b2e5` | App   | Update `createWorkspace` to write `definition.json`, `getWorkspace` to read from it                             |
| `6b934e8` | App   | Update `+layout.ts` to read definition from JSON                                                                |
| `b2afd6a` | App   | Remove unused `extract-definition.ts`                                                                           |

### Files Changed

```
packages/epicenter/                          # SDK
├── package.json                             # +humanize-string
├── src/index.ts                             # New exports
└── src/core/workspace/
    ├── workspace.ts                         # defineWorkspace overloads, removed createDefinition
    ├── normalize.ts                         # NEW: normalization types and functions
    └── index.ts                             # New exports

apps/epicenter/                              # Tauri App
├── src/lib/providers/
│   └── definition-persistence.ts            # NEW: read/write definition.json
├── src/lib/query/
│   └── workspaces.ts                        # Updated create/get to use definition.json
├── src/lib/utils/
│   └── extract-definition.ts                # DELETED
└── src/routes/(workspace)/workspaces/[id]/
    └── +layout.ts                           # Read definition from JSON
```

### Before vs After

```
BEFORE: Definition in Y.Doc (CRDT overhead)
┌─────────────────────────────────────────────────────────┐
│  Y.Doc (workspace)                                      │
│  ├── definition: Y.Map                                  │
│  │   ├── name: "Whispering"          ← CRDT overhead   │
│  │   ├── slug: "whispering"          ← rarely changes  │
│  │   └── tables: Y.Map               ← schema bloat    │
│  ├── tables: Y.Map<rows>             ← actual data     │
│  └── kv: Y.Map<values>               ← actual data     │
└─────────────────────────────────────────────────────────┘

AFTER: Definition in static JSON
┌─────────────────────────────────────────────────────────┐
│  definition.json (static file)                          │
│  {                                                      │
│    "id": "...",                                         │
│    "name": "Whispering",                                │
│    "tables": { ... },                                   │
│    "kv": { ... }                                        │
│  }                                                      │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  Y.Doc (workspace) - DATA ONLY                          │
│  ├── tables: Y.Map<rows>             ← actual data     │
│  └── kv: Y.Map<values>               ← actual data     │
└─────────────────────────────────────────────────────────┘
```

### What's Left (Future Work)

- **Definition editing in UI**: The `addTable`, `removeTable`, `addKvEntry`, `removeKvEntry` mutations are currently stubbed. They need to update `definition.json` directly (not go through Y.Doc).

### Testing Notes

To verify the implementation:

1. Run the Epicenter app (`bun dev` in `apps/epicenter`)
2. Create a new workspace
3. Check that `~/Library/Application Support/com.tauri.dev/workspaces/{guid}/definition.json` was created
4. Verify the workspace loads correctly after restart
