# Reactive State Pattern

## When to Read This

Read when working with `fromTable`/`fromKv` reactive wrappers, building state modules, or converting SvelteMap data to arrays for derived state or component props.

## Reactive Table State Pattern

When a factory function exposes workspace table data via `fromTable`, follow this three-layer convention:

```typescript
// 1. Map — reactive source (private, suffixed with Map)
const foldersMap = fromTable(workspaceClient.tables.folders);

// 2. Derived array — cached materialization (private, no suffix)
const folders = $derived(foldersMap.values().toArray());

// 3. Getter — public API (matches the derived name)
return {
	get folders() {
		return folders;
	},
};
```

Naming: `{name}Map` (private source) → `{name}` (cached derived) → `get {name}()` (public getter).

### With Sort or Filter

Chain operations inside `$derived` — the entire pipeline is cached:

```typescript
const tabs = $derived(tabsMap.values().toArray().sort((a, b) => b.savedAt - a.savedAt));
const notes = $derived(allNotes.filter((n) => n.deletedAt === undefined));
```

See the `typescript` skill for iterator helpers (`.toArray()`, `.filter()`, `.find()` on `IteratorObject`).

### Template Props

For component props expecting `T[]`, derive in the script block — never materialize in the template:

```svelte
<!-- Bad: re-creates array on every render -->
<FujiSidebar entries={entries.values().toArray()} />

<!-- Good: cached via $derived -->
<script>
	const entriesArray = $derived(entries.values().toArray());
</script>
<FujiSidebar entries={entriesArray} />
```

### Why `$derived`, Not a Plain Getter

Put reactive computations in `$derived`, not inside public getters.

A getter may still be reactive if it reads reactive state, but it recomputes on every access. `$derived` computes reactively and caches until dependencies change.

Use `$derived` for the computation. Use the getter only as a pass-through to expose that derived value.

See `docs/articles/derived-vs-getter-caching-matters.md` for rationale.

## Reactive State Module Conventions

State modules use a factory function that returns a flat object with getters and methods, exported as a singleton.

```typescript
function createBookmarkState() {
	const bookmarksMap = fromTable(workspaceClient.tables.bookmarks);
	const bookmarks = $derived(bookmarksMap.values().toArray());

	return {
		get bookmarks() { return bookmarks; },
		async add(tab: Tab) { /* ... */ },
		remove(id: BookmarkId) { /* ... */ },
	};
}

export const bookmarkState = createBookmarkState();
```

### Naming

| Concern | Convention | Example |
|---|---|---|
| **Export name** | `xState` for domain state; descriptive noun for utilities | `bookmarkState`, `notesState`, `deviceConfig`, `vadRecorder` |
| **Factory function** | `createX()` matching the export name | `createBookmarkState()` |
| **File name** | Domain name, optionally with `-state` suffix | `bookmark-state.svelte.ts`, `auth.svelte.ts` |

Use the `State` suffix when the export name would collide with a key property (`bookmarkState.bookmarks`, not `bookmarks.bookmarks`).

### Accessor Patterns

| Data Shape | Accessor | Example |
|---|---|---|
| **Collection** | Named getter | `bookmarkState.bookmarks`, `notesState.notes` |
| **Single reactive value** | `.current` (Svelte 5 convention) | `selectedFolderId.current`, `serverUrl.current` |
| **Keyed lookup** | `.get(key)` | `toolTrustState.get(name)`, `deviceConfig.get(key)` |
