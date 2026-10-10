# @epicenter/svelte

Svelte utilities for synchronizing state with external systems.

## Overview

This package provides utilities that help synchronize Svelte state with external data sources like local storage, remote APIs, or other browser APIs. These utilities handle the complexity of keeping state in sync across multiple sources while maintaining Svelte's reactive paradigm.

## Installation

This package is part of the Epicenter monorepo and is used internally. To use it in your app:

```json
{
  "dependencies": {
    "@epicenter/svelte": "workspace:*"
  }
}
```

## Available Utilities

### `edit-session` (`@epicenter/svelte/edit-session`)

Edit sessions over `@epicenter/folder` files: the app owns the draft and the
folder's guarded autosave writes it. `createRowSession(table, stored)` edits a
valid row; `createTextSession(files, opened)` edits a file's text and keeps
input well formed with `wellFormed` from `@epicenter/folder`. Both are `createEditSession` over a source
(`rowSource`, `textSource`) that says how to save, read again, and recreate.

```ts
const session = createRowSession(folder.tables.todos, stored, { locked });
session.edit((row) => {
	row.fields.title = 'Oat milk';
}); // saves at once; only the latest request waits
session.state; // saving | saved | error, each with `file`, the last confirmed capture
await session.keepMine(); // after Conflict: save the draft over theirs, or recreate it
await session.reloadTheirs(); // after Conflict: show theirs in place of the draft
await session.rename((file) => folder.tables.todos.rename(file, 'next'));
session.release(); // the person left: no input, and a running command starts nothing more
```

A save never assigns the draft. `keepMine`, `reloadTheirs`, and `rename` run
one at a time with input locked (`session.locked`), and `settled()` waits for
them. `adopt()` takes a newer version of the file only while the session is
saved and idle. `generation` advances whenever a read replaces the draft, for
views such as a rich text editor that must remount then. Which item is open,
leaving, and what a person is told stay with the app.

### `open-item` (`@epicenter/svelte/open-item`)

The one item a page has open. `createOpenItem({ load, sessionOf, holds, closed })`
keeps what `load` built for a key and owns how it is left: opening another key
waits for the open session's saves and releases it, or answers
`{ kind: 'unsaved', session }` so the app can ask and open again with
`{ discard: session }`. Opening the shown key does nothing, and a load that
answers after a newer open is released. `keepMine` and `reloadTheirs` act
only on the session given while it is open; Reload theirs closes a gone file
and reopens one that cannot be shown through `load`. `removeOpen(session, remove)`
releases, waits for the saves, and removes what the last one confirmed. What an
item is, listings, refusals, and wording stay with the app. A page with
several drafts open at once keeps its own map.

### `admissions` (`@epicenter/svelte/admissions`)

`createAdmissions()` counts the work a page started so closing can wait for
it. `command(fn)` wraps a whole method so each call counts from the call,
before its first await; `admit(fn)` counts one piece; `quiet()` waits for all
of it; `busy` is reactive.

### `SaveBar` (`@epicenter/svelte/save-bar`)

The save state and conflict prompt for one edit session: Reload theirs or
Keep mine for a change made elsewhere, Discard or Keep mine for a file deleted
elsewhere (Discard only without `onKeepMine`), Try again or Save again for
other failures, and what to fix for a value a row cannot hold.

### `fromData`

Adapts one opened `@epicenter/app/store` handle into Svelte reactivity, mirroring
the declaration: `tables.<name>`, `kv`, and `persistence`, with the same verbs
and the same types. Other handle members pass through unchanged. Reads are reactive; writes pass through unchanged. Repeated
calls with the same raw store return the same wrapper without reseeding tables
or adding subscriptions, so route components can remount over one open store.

A table is HELD as a `SvelteMap` projection keyed by row id, seeded when
`fromData` is called and patched with the row ids each commit names, because
building a row out of CRDT structs costs about two microseconds and rebuilding
ten thousand of them per keystroke does not. `kv` and `persistence` stay
read-through: ten keys and one enum are not worth holding.

Nothing is disposed by hand. The projection and its subscription live as long
as the document they mirror, deliberately: one detached from its source stays
alive and stops being true.

```ts
const app = fromData(data);
const active = $derived(app.tables.notes.rows.filter((n) => !n.deletedAt));
const note = app.tables.notes.get(id);   // wakes only when THAT row moves
app.persistence.get() === 'blocked';     // this device stopped saving
```

### `fromKv`

Adapts KV reads without building table projections. Use it when a view needs
device settings while displaying another store. Repeated calls reuse the same
wrapper, including calls through `fromData`. Writes pass through unchanged.

```ts
const preferences = fromKv(local.kv);
preferences.get('showDetails');
preferences.update({ showDetails: true });
```

### `fromSubscription`

One value read through a subscription, kept fresh. The four lines every
adapter in this repo used to write by hand, written once, so the announce
cannot be forgotten: forget it and the value stays correct and never updates
again.

```ts
const preview = fromSubscription(
  (update) => table.watch(body, update),
  () => notePreview(body),
);
preview.current;
```

### `createPersistedState`

Creates a persisted state object tied to local storage, accessible through `.value`. This utility ensures your state survives page refreshes and synchronizes across browser tabs.

#### Features

- **Synchronous initialization**: Immediate access to a valid value
- **Automatic validation**: Uses the provided schema to validate stored data
- **Cross-tab synchronization**: Syncs state across browser tabs via storage events
- **Graceful error recovery**: Falls back to defaults via `onParseError` handler
- **Type-safe**: Full TypeScript support with inferred types

#### Usage

```typescript
import { createPersistedState } from '@epicenter/svelte';
import { z } from 'zod';

// Define your schema
const settingsSchema = z.object({
  theme: z.enum(['light', 'dark']),
  notifications: z.boolean()
});

// Create persisted state
const settings = createPersistedState({
  key: 'app-settings',
  schema: settingsSchema,
  onParseError: (error) => {
    // Handle different error types
    if (error.type === 'storage_empty') {
      return { theme: 'light', notifications: true }; // default value
    }
    console.error('Settings parse error:', error);
    return { theme: 'light', notifications: true }; // fallback value
  }
});

// Use in component
$effect(() => {
  console.log('Current theme:', settings.value.theme);
});

// Update settings
settings.value = { theme: 'dark', notifications: false };
```

**Note:** For production use, consider wrapping the persisted state in an encapsulated pattern with controlled access methods. See [Encapsulated State Pattern](../../docs/patterns/encapsulated-state-pattern.md) for best practices.

#### API

```typescript
createPersistedState<TSchema extends StandardSchemaV1>(options: {
  key: string;
  schema: TSchema;
  onParseError: (error: ParseErrorReason<TSchema>) => StandardSchemaV1.InferOutput<TSchema>;
  onUpdateSuccess?: (newValue: StandardSchemaV1.InferOutput<TSchema>) => void;
  onUpdateError?: (error: unknown) => void;
  onUpdateSettled?: () => void;
})
```

#### Parameters

- **`key`**: The key used to store the value in local storage
- **`schema`**: A Standard Schema v1 compatible schema for validation
- **`onParseError`**: Handler called when the value from storage cannot be parsed or validated. Must return a valid default value.
- **`onUpdateSuccess`** (optional): Called when the value is successfully written to storage
- **`onUpdateError`** (optional): Called when writing to storage fails
- **`onUpdateSettled`** (optional): Called after update attempt completes (success or failure)

#### Error Types

The `onParseError` handler receives one of these error types:

- **`storage_empty`**: No value found in storage for the given key
- **`json_parse_error`**: Failed to parse the stored JSON string
- **`schema_validation_async_during_sync`**: Schema validation returned a Promise during synchronous parsing
- **`schema_validation_failed`**: Schema validation failed with specific issues

#### Example: Persisting Table State

```typescript
// Persist table sorting state
const sorting = createPersistedState({
  key: 'data-table-sorting',
  schema: z.array(z.object({
    id: z.string(),
    desc: z.boolean()
  })),
  onParseError: () => [{ id: 'created_at', desc: true }] // default sort
});

// Persist row selection
const rowSelection = createPersistedState({
  key: 'data-table-selection',
  schema: z.record(z.boolean()),
  onParseError: () => ({}) // no selection by default
});
```

## Contributing

When adding new utilities to this package:

1. Add the utility file to `src/`
2. Export it from `src/index.ts`
3. Update this README with documentation
4. Add type tests if applicable

## Dependencies

This package depends on:

- `svelte`: For reactive state primitives
- `@standard-schema/spec`: For schema validation types
- `wellcrafted`: For error handling utilities
