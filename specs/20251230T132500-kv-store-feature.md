# KV Store Feature Specification

**Date**: 2025-12-30
**Status**: Draft
**Author**: AI-assisted

## Overview

Add a `kv` (key-value) store capability to Epicenter workspaces alongside the existing `tables` system. The KV store uses the same column type constructors (`text()`, `integer()`, `ytext()`, etc.) but with a simpler one-level-shallower data structure optimized for singleton values rather than collections of rows.

## Motivation

Tables are excellent for collections of records (posts, users, sessions), but many use cases require singleton configuration or state values:

- **Settings**: `theme: 'dark'`, `locale: 'en-US'`
- **Cursors**: `lastSyncTimestamp`, `currentPageIndex`
- **Feature flags**: `betaFeaturesEnabled: true`
- **Session state**: `currentUserId`, `authToken`

Currently, these must be stored as single-row tables, which is awkward:

```typescript
// Current workaround: awkward single-row table pattern
tables: {
  settings: {
    id: id(),  // Always 'singleton' - wasteful
    theme: text({ default: 'light' }),
    locale: text({ default: 'en-US' }),
  }
}
// Usage: tables.settings.get({ id: 'singleton' })
```

With KV:

```typescript
// Proposed: clean singleton values
kv: {
  theme: text({ default: 'light' }),
  locale: text({ default: 'en-US' }),
}
// Usage: kv.theme.get() → 'light'
```

## Design Principles

1. **Same column types**: Reuse all existing column constructors from `core/schema/columns.ts`
2. **One level shallower**: KV is `Y.Map(keyName → value)` vs tables' `Y.Map(tableName → Y.Map(rowId → Y.Map(field → value)))`
3. **Consistent API pattern**: `$kv` mirrors `$tables` on the workspace client
4. **Server parity**: REST endpoints follow the same URL hierarchy pattern

## Architecture Comparison

### Tables (Current)

```
Y.Doc
└── Y.Map('tables')
    └── Y.Map('posts')           // Table name
        └── Y.Map('row-123')     // Row ID
            ├── id: 'row-123'
            ├── title: 'Hello'
            └── content: Y.Text
```

### KV (Proposed)

```
Y.Doc
└── Y.Map('kv')
    ├── theme: 'dark'           // Key → primitive value
    ├── locale: 'en-US'         // Key → primitive value
    └── currentDoc: Y.Text      // Key → Y.js type
```

## API Design

### Workspace Configuration

```typescript
import {
	defineWorkspace,
	id,
	text,
	ytext,
	integer,
	boolean,
	date,
	json,
} from '@epicenter/hq';

const appWorkspace = defineWorkspace({
	id: 'app',

	tables: {
		posts: {
			id: id(),
			title: text(),
			content: ytext(),
		},
	},

	// NEW: KV store configuration
	kv: {
		// Same column types as tables, but NO `id` column (keys are the identifiers)
		theme: text({ default: 'light' }),
		locale: text({ default: 'en-US' }),
		lastSyncAt: date({ nullable: true }),
		betaFeatures: boolean({ default: false }),
		currentDraft: ytext({ nullable: true }),
		userPrefs: json({
			schema: type({ notifications: 'boolean', fontSize: 'number' }),
			default: { notifications: true, fontSize: 14 },
		}),
	},

	providers: {
		/* ... */
	},

	actions: ({ tables, kv, providers }) => ({
		// KV is available in actions context
		setTheme: defineMutation({
			input: type({ theme: '"light" | "dark"' }),
			handler: ({ theme }) => {
				kv.theme.set(theme);
			},
		}),

		getTheme: defineQuery({
			handler: () => kv.theme.get(),
		}),
	}),
});
```

### Client API

```typescript
const client = await createClient(appWorkspace);

// Access KV store via $kv (mirrors $tables pattern)
client.$kv.theme.get(); // → 'light' (default)
client.$kv.theme.set('dark'); // Set value
client.$kv.theme.get(); // → 'dark'

// Nullable values
client.$kv.lastSyncAt.get(); // → null (not set)
client.$kv.lastSyncAt.set(
	DateWithTimezone({ date: new Date(), timezone: 'UTC' }),
);

// Y.js collaborative types
const draft = client.$kv.currentDraft.get(); // → Y.Text or null
if (draft) {
	draft.insert(0, 'Hello'); // Collaborative editing
}

// JSON values
const prefs = client.$kv.userPrefs.get(); // → { notifications: true, fontSize: 14 }
client.$kv.userPrefs.set({ notifications: false, fontSize: 16 });

// Observe changes (reactive)
const unsubscribe = client.$kv.theme.observe((value) => {
	console.log('Theme changed to:', value);
});
```

### KV Helper Methods

Each KV key exposes a typed helper with these methods:

| Method              | Description                   | Signature                                    |
| ------------------- | ----------------------------- | -------------------------------------------- |
| `get()`             | Get current value             | `() => T \| null` (if nullable) or `() => T` |
| `set(value)`        | Set value                     | `(value: T) => void`                         |
| `observe(callback)` | Watch for changes             | `(cb: (value: T) => void) => () => void`     |
| `reset()`           | Reset to default (if defined) | `() => void`                                 |

### Server Endpoints

Following the existing URL hierarchy pattern:

```
/workspaces/{workspaceId}/kv                    # List all KV keys and values (GET)
/workspaces/{workspaceId}/kv/{keyName}          # Single key operations
  - GET    → Get value
  - PUT    → Set value
  - DELETE → Reset to default (or null if no default)
```

**Examples:**

```bash
# Get theme value
GET /workspaces/app/kv/theme
# Response: { "data": "dark" }

# Set theme value
PUT /workspaces/app/kv/theme
Content-Type: application/json
{ "value": "light" }
# Response: { "data": "light" }

# List all KV pairs
GET /workspaces/app/kv
# Response: { "data": { "theme": "dark", "locale": "en-US", ... } }

# Reset to default
DELETE /workspaces/app/kv/theme
# Response: { "data": "light" } (returns the default value)
```

## Type System

### KV Schema Types

```typescript
// New type: KV schema is a record of column schemas (no id column)
export type KvSchema = Record<string, Exclude<ColumnSchema, IdColumnSchema>>;

// KV value type (similar to CellValue but excludes id handling)
export type KvValue<C extends ColumnSchema> = CellValue<C>;

// Serialized KV value (for transport)
export type SerializedKvValue<C extends ColumnSchema> = SerializedCellValue<C>;
```

### WorkspaceConfig Extension

```typescript
export type WorkspaceConfig<
	TDeps extends readonly AnyWorkspaceConfig[],
	TId extends string,
	TWorkspaceSchema extends WorkspaceSchema,
	TKvSchema extends KvSchema, // NEW
	TProviderResults extends WorkspaceProviderMap,
	TActions extends Actions,
> = {
	id: TId;
	tables: TWorkspaceSchema;
	kv?: TKvSchema; // NEW: Optional KV config
	dependencies?: TDeps;
	providers: {
		/* ... */
	};
	actions: (context: {
		ydoc: Y.Doc;
		tables: Tables<TWorkspaceSchema>;
		kv: Kv<TKvSchema>; // NEW: KV in actions context
		validators: WorkspaceValidators<TWorkspaceSchema>;
		workspaces: WorkspacesToActions<TDeps>;
		providers: TProviderResults;
		blobs: WorkspaceBlobs<TWorkspaceSchema>;
		paths: WorkspacePaths | undefined;
	}) => TActions;
};
```

### KV Helper Type

```typescript
/**
 * Type-safe KV helper for a single key.
 */
export type KvHelper<TColumnSchema extends ColumnSchema> = {
	/** Get the current value */
	get: Query<void, KvValue<TColumnSchema>>;

	/** Set the value */
	set: Mutation<SerializedKvValue<TColumnSchema>, void>;

	/** Observe value changes */
	observe: (callback: (value: KvValue<TColumnSchema>) => void) => () => void;

	/** Reset to default value (if defined) or null */
	reset: Mutation<void, void>;

	/** The column schema for this key */
	schema: TColumnSchema;

	/** The key name */
	name: string;

	/** Type inference helper */
	$inferValue: KvValue<TColumnSchema>;
};

/**
 * Maps KV schema to KV helpers.
 */
export type Kv<TKvSchema extends KvSchema> = {
	[K in keyof TKvSchema]: KvHelper<TKvSchema[K]>;
} & {
	/** Get all KV helpers as an array */
	defined(): KvHelper<TKvSchema[keyof TKvSchema]>[];

	/** Get all values as a plain object */
	toJSON(): { [K in keyof TKvSchema]: SerializedKvValue<TKvSchema[K]> };
};
```

## Implementation Plan

### Phase 1: Core KV System

- [ ] **1.1** Add `KvSchema` type to `core/schema/types.ts`
- [ ] **1.2** Create `core/kv/kv-helper.ts` with `createKvHelper()` function
- [ ] **1.3** Create `core/kv/core.ts` with `createKv()` function (mirrors `createTables()`)
- [ ] **1.4** Add `kv` and `Kv` type exports to `core/schema/index.ts`

### Phase 2: Workspace Integration

- [ ] **2.1** Extend `WorkspaceConfig` type to include optional `kv` field
- [ ] **2.2** Update `defineWorkspace()` to validate KV schema (no `id` column allowed)
- [ ] **2.3** Update `client.node.ts` `initializeWorkspaces()` to create KV helpers
- [ ] **2.4** Update `client.browser.ts` `initializeWorkspacesSync()` similarly
- [ ] **2.5** Add `$kv` to `WorkspaceClientInternals` type
- [ ] **2.6** Pass `kv` to actions factory context

### Phase 3: Server Endpoints

- [ ] **3.1** Create `server/kv.ts` with `createKvPlugin()` function
- [ ] **3.2** Implement GET `/workspaces/{id}/kv` (list all)
- [ ] **3.3** Implement GET `/workspaces/{id}/kv/{key}` (get single)
- [ ] **3.4** Implement PUT `/workspaces/{id}/kv/{key}` (set value)
- [ ] **3.5** Implement DELETE `/workspaces/{id}/kv/{key}` (reset)
- [ ] **3.6** Add KV plugin to main `server.ts`

### Phase 4: Provider Support

- [ ] **4.1** Update SQLite provider to sync KV values (single-row table per workspace)
- [ ] **4.2** Update Markdown provider to optionally persist KV as frontmatter or separate file

### Phase 5: Documentation & Tests

- [ ] **5.1** Add KV section to `packages/epicenter/README.md`
- [ ] **5.2** Create `core/kv/kv.test.ts` with unit tests
- [ ] **5.3** Add KV integration tests to `core/workspace.test.ts`
- [ ] **5.4** Add server endpoint tests

## File Structure

```
packages/epicenter/src/
├── core/
│   ├── kv/                          # NEW
│   │   ├── core.ts                  # createKv() function
│   │   ├── kv-helper.ts             # KvHelper implementation
│   │   └── index.ts                 # Barrel exports
│   ├── schema/
│   │   └── types.ts                 # Add KvSchema type
│   └── workspace/
│       ├── config.ts                # Extend WorkspaceConfig
│       ├── client.node.ts           # Add KV initialization
│       ├── client.browser.ts        # Add KV initialization
│       └── client.shared.ts         # Add $kv to internals
├── server/
│   ├── kv.ts                        # NEW: createKvPlugin()
│   └── server.ts                    # Add KV plugin
└── index.shared.ts                  # Export KV types
```

## Implementation Details

### YJS Structure for KV

```typescript
// In core/kv/core.ts
export function createKv<TKvSchema extends KvSchema>(
	ydoc: Y.Doc,
	schema: TKvSchema,
) {
	// Single-level Y.Map for all KV pairs
	const ykvMap = ydoc.getMap<CellValue>('kv');

	// Create helpers for each key
	const kvHelpers = Object.fromEntries(
		Object.entries(schema).map(([keyName, columnSchema]) => [
			keyName,
			createKvHelper({
				ydoc,
				keyName,
				ykvMap,
				schema: columnSchema,
			}),
		]),
	);

	return {
		...kvHelpers,

		defined() {
			return Object.values(kvHelpers);
		},

		toJSON() {
			const result: Record<string, unknown> = {};
			for (const [key, helper] of Object.entries(kvHelpers)) {
				result[key] = serializeCellValue(helper.get());
			}
			return result;
		},
	} as Kv<TKvSchema>;
}
```

### KV Helper Implementation

```typescript
// In core/kv/kv-helper.ts
function createKvHelper<TColumnSchema extends ColumnSchema>({
	ydoc,
	keyName,
	ykvMap,
	schema,
}: {
	ydoc: Y.Doc;
	keyName: string;
	ykvMap: Y.Map<CellValue>;
	schema: TColumnSchema;
}): KvHelper<TColumnSchema> {
	// For Y.js types (ytext, tags), create lazily
	const getOrCreateYjsValue = () => {
		let value = ykvMap.get(keyName);
		if (!value && schema.type === 'ytext') {
			value = new Y.Text();
			ykvMap.set(keyName, value);
		}
		if (!value && schema.type === 'multi-select') {
			value = new Y.Array();
			ykvMap.set(keyName, value);
		}
		return value;
	};

	return {
		name: keyName,
		schema,

		get: defineQuery({
			description: `Get ${keyName} value`,
			handler: () => {
				const value = ykvMap.get(keyName);
				if (value === undefined) {
					// Return default if defined, otherwise null
					return getDefaultValue(schema) ?? null;
				}
				return value as KvValue<TColumnSchema>;
			},
		}),

		set: defineMutation({
			input: createKvInputSchema(schema),
			description: `Set ${keyName} value`,
			handler: (input) => {
				ydoc.transact(() => {
					if (schema.type === 'ytext') {
						const ytext = getOrCreateYjsValue() as Y.Text;
						updateYTextFromString(ytext, input as string);
					} else if (schema.type === 'multi-select') {
						const yarray = getOrCreateYjsValue() as Y.Array<string>;
						updateYArrayFromArray(yarray, input as string[]);
					} else {
						ykvMap.set(keyName, input);
					}
				});
			},
		}),

		observe(callback) {
			const handler = () => {
				callback(ykvMap.get(keyName) as KvValue<TColumnSchema>);
			};
			ykvMap.observe(handler);
			return () => ykvMap.unobserve(handler);
		},

		reset: defineMutation({
			description: `Reset ${keyName} to default`,
			handler: () => {
				ydoc.transact(() => {
					const defaultValue = getDefaultValue(schema);
					if (defaultValue !== undefined) {
						ykvMap.set(keyName, defaultValue);
					} else {
						ykvMap.delete(keyName);
					}
				});
			},
		}),

		$inferValue: null as unknown as KvValue<TColumnSchema>,
	};
}
```

### Server KV Plugin

```typescript
// In server/kv.ts
export function createKvPlugin(
	workspaceClients: Record<string, WorkspaceClient<Actions>>,
) {
	const app = new Elysia();

	for (const [workspaceId, workspaceClient] of Object.entries(
		workspaceClients,
	)) {
		const kv = workspaceClient.$kv;
		if (!kv) continue; // Skip workspaces without KV

		const basePath = `/workspaces/${workspaceId}/kv`;
		const tags = [workspaceId, 'kv'];

		// List all KV pairs
		app.get(basePath, () => kv.toJSON(), {
			detail: { description: `List all KV pairs for ${workspaceId}`, tags },
		});

		// Per-key endpoints
		for (const kvHelper of kv.defined()) {
			const keyPath = `${basePath}/${kvHelper.name}`;

			// Get value
			app.get(keyPath, () => kvHelper.get(), {
				detail: { description: `Get ${kvHelper.name}`, tags },
			});

			// Set value
			app.put(
				keyPath,
				({ body }) => {
					kvHelper.set(body.value);
					return { data: kvHelper.get() };
				},
				{
					body: t.Object({
						value: kvHelper.schema /* convert to Elysia schema */,
					}),
					detail: { description: `Set ${kvHelper.name}`, tags },
				},
			);

			// Reset value
			app.delete(
				keyPath,
				() => {
					kvHelper.reset();
					return { data: kvHelper.get() };
				},
				{
					detail: { description: `Reset ${kvHelper.name} to default`, tags },
				},
			);
		}
	}

	return app;
}
```

## Validation Rules

1. **No `id` column in KV**: KV keys serve as identifiers; `id()` columns are not allowed
2. **Reserved key names**: Keys starting with `$` are reserved (consistent with tables)
3. **Key naming**: Same pattern as table/column names (`/^[a-z][a-z0-9_]*$/`)
4. **Type validation**: Values are validated against column schemas on set

## Edge Cases

### Default Values

- If a column has a `default`, `get()` returns the default when no value is set
- `reset()` restores the default value (or deletes if no default)

### Nullable Values

- Nullable columns return `null` when not set and no default exists
- Non-nullable columns without defaults throw on `get()` if never set (or return schema error)

### Y.js Types (ytext, tags)

- Created lazily on first access or set
- `get()` returns the Y.js type directly for collaborative editing
- `set()` uses sync utilities to apply minimal changes

### Sync Behavior

- KV values sync via the same Y.Doc as tables
- WebSocket sync provider automatically includes KV changes
- SQLite provider stores KV in a dedicated `_kv` table per workspace

## Open Questions

1. **Should KV support `observe()` at the store level?** (e.g., `$kv.$observe()` for any change)
2. **Should providers expose KV separately?** (e.g., `providers.sqlite.$kv` vs merged)
3. **Should KV keys support nested objects natively?** (vs. using `json()` column type)

## Alternatives Considered

### Alternative 1: Single-Row Table Pattern

Keep using tables with a singleton row. Rejected because:

- Requires wasteful `id` column
- Awkward API (`get({ id: 'singleton' })`)
- Misleading semantics (it's not really a "table")

### Alternative 2: Separate Y.Doc for KV

Use a dedicated Y.Doc for KV storage. Rejected because:

- Complicates sync (two docs per workspace)
- Adds provider complexity
- No clear benefit over shared Y.Doc

### Alternative 3: JSON Blob Storage

Store all KV as a single JSON blob. Rejected because:

- Loses field-level CRDT merging
- Can't use Y.Text/Y.Array for collaborative editing
- Coarse-grained change detection

## Success Criteria

- [ ] KV config works in `defineWorkspace()` with full type inference
- [ ] `$kv` is accessible on workspace client with typed helpers
- [ ] All column types work in KV (except `id`)
- [ ] Y.js types (ytext, tags) support collaborative editing
- [ ] Server endpoints match the URL hierarchy pattern
- [ ] SQLite provider syncs KV values
- [ ] Documentation covers all use cases

## References

- `packages/epicenter/src/core/db/core.ts` - Tables implementation to mirror
- `packages/epicenter/src/core/db/table-helper.ts` - Helper pattern to follow
- `packages/epicenter/src/server/tables.ts` - Server endpoint pattern
- `packages/epicenter/src/core/schema/columns.ts` - Column type constructors
