# Migrate View State to URL Search Params (Honeycrisp + Opensidian)

Replicate the Fuji pattern: replace workspace KV (`fromKv`) and ephemeral `$state` with URL search params via `page.url.searchParams` + `goto()`.

---

## Pattern (from Fuji)

```
URL is the source of truth for view preferences.
Defaults are elided — clean URL = all defaults.
goto() with replaceState: true, noScroll: true, keepFocus: true.
setSearchParam() utility shared within each app.
```

### Shared utility shape (per-app, not cross-app)

```ts
import { goto } from '$app/navigation';
import { page } from '$app/state';

function setSearchParam(key: string, value: string | null) {
  const params = new URLSearchParams(page.url.searchParams);
  if (value === null) params.delete(key);
  else params.set(key, value);
  const search = params.toString();
  goto(`${page.url.pathname}${search ? `?${search}` : ''}${page.url.hash}`, {
    replaceState: true, noScroll: true, keepFocus: true,
  });
}
```

---

## App 1: Honeycrisp

### URL param mapping

| State | Param | Default (elided) | Type |
|---|---|---|---|
| `selectedFolderId` | `?folder=<id>` | `null` (all notes) | `FolderId \| null` |
| `selectedNoteId` | `?note=<id>` | `null` (no note open) | `NoteId \| null` |
| `sortBy` | `?sort=dateCreated\|title` | `dateEdited` | `'dateEdited' \| 'dateCreated' \| 'title'` |
| `searchQuery` | `?q=<text>` | `''` (empty) | `string` |
| `isRecentlyDeletedView` | `?view=deleted` | not present (false) | `boolean` via presence |
| `sidebarCollapsed` | **STAYS** — not linkable | — | — |

### Files to change

#### 1. `apps/honeycrisp/src/lib/state/view.svelte.ts` — Main migration

Replace `fromKv` + `$state` with URL search params.

**Before:**
```ts
import { fromKv } from '@epicenter/svelte';
import { workspace } from '$lib/client';

const selectedFolderId = fromKv(workspace.kv, 'selectedFolderId');
const selectedNoteId = fromKv(workspace.kv, 'selectedNoteId');
const sortBy = fromKv(workspace.kv, 'sortBy');
let searchQuery = $state('');
let isRecentlyDeletedView = $state(false);
```

**After:**
```ts
import { goto } from '$app/navigation';
import { page } from '$app/state';

type SortBy = 'dateEdited' | 'dateCreated' | 'title';
const SORT_KEYS: SortBy[] = ['dateEdited', 'dateCreated', 'title'];

function setSearchParam(key: string, value: string | null) { /* shared utility */ }

// All reads go through page.url.searchParams (reactive in .svelte.ts)
// All writes go through setSearchParam() → goto()
```

**Public API changes (same getters, different backing store):**

```ts
get selectedFolderId() {
  return (page.url.searchParams.get('folder') as FolderId) ?? null;
},
get selectedNoteId() {
  return (page.url.searchParams.get('note') as NoteId) ?? null;
},
get sortBy(): SortBy {
  const raw = page.url.searchParams.get('sort');
  return SORT_KEYS.includes(raw as SortBy) ? (raw as SortBy) : 'dateEdited';
},
get searchQuery() {
  return page.url.searchParams.get('q') ?? '';
},
get isRecentlyDeletedView() {
  return page.url.searchParams.get('view') === 'deleted';
},
```

**Methods update (write via setSearchParam):**

```ts
selectFolder(folderId: FolderId | null) {
  // Clear note, clear deleted view, set folder
  setSearchParam('view', null);
  setSearchParam('note', null);
  setSearchParam('folder', folderId);
},
selectRecentlyDeleted() {
  setSearchParam('view', 'deleted');
  setSearchParam('folder', null);
  setSearchParam('note', null);
},
selectNote(noteId: NoteId) {
  setSearchParam('note', noteId);
},
setSortBy(value: SortBy) {
  setSearchParam('sort', value === 'dateEdited' ? null : value);
},
setSearchQuery(query: string) {
  setSearchParam('q', query || null);
},
```

**Derived state** (`filteredNotes`, `folderName`, `selectedNote`) stays as `$derived` — these read the getters which now read `page.url.searchParams`. Reactivity preserved because `page` is reactive in `.svelte.ts`.

**Remove imports:** `fromKv` from `@epicenter/svelte`, `workspace` from `$lib/client`.
**Remove imports (if unused):** `FolderId`, `NoteId` from `$lib/workspace` — keep if used in type annotations.

#### 2. `apps/honeycrisp/src/lib/state/notes.svelte.ts` — Cross-cutting KV calls

Three call sites read/write `workspace.kv` for `selectedNoteId`:

**Line 129–131 (`softDeleteNote`):**
```ts
// Before:
if (workspace.kv.get('selectedNoteId') === noteId) {
  workspace.kv.set('selectedNoteId', null);
}

// After:
if (page.url.searchParams.get('note') === noteId) {
  setSearchParam('note', null);
}
```

**Line 172–174 (`permanentlyDeleteNote`):** Same pattern.

**Line 239 (`updateNoteContent`):**
```ts
// Before:
const selectedNoteId = workspace.kv.get('selectedNoteId');

// After:
const selectedNoteId = page.url.searchParams.get('note') as NoteId | null;
```

**New imports needed:** `page` from `$app/state`, `goto` from `$app/navigation` (for `setSearchParam`).

**Note on avoiding circular deps:** `notes.svelte.ts` imports the `setSearchParam` utility directly (or defines its own copy) — it does NOT import `viewState` because `view.svelte.ts` already imports `notesState`.

To avoid duplicating `setSearchParam`, extract it to a shared file:
```
apps/honeycrisp/src/lib/url-state.ts
```
Both `view.svelte.ts` and `notes.svelte.ts` import from there.

#### 3. `apps/honeycrisp/src/lib/workspace/workspace.ts` — Folder delete action

The `defineMutation` handler clears selection via KV:
```ts
if (kv.get('selectedFolderId') === folderId) {
  kv.set('selectedFolderId', null);
}
```

**Problem:** Mutation handlers run in workspace context, not Svelte context. `page` from `$app/state` is not available in plain `.ts` files.

**Solution:** Remove the selection clearing from the mutation handler. Move it to `foldersState.deleteFolder()`:

```ts
// workspace.ts — remove KV selection logic, keep only data ops:
handler: ({ folderId: rawId }) => {
  const folderId = rawId as FolderId;
  const folderNotes = tables.notes.getAllValid().filter(n => n.folderId === folderId);
  for (const note of folderNotes) {
    tables.notes.update(note.id, { folderId: undefined });
  }
  tables.folders.delete(folderId);
  // Selection clearing moved to foldersState.deleteFolder()
},
```

```ts
// folders.svelte.ts — add selection clearing after action:
import { page } from '$app/state';
import { setSearchParam } from '$lib/url-state';

deleteFolder(folderId: FolderId) {
  workspace.actions.folders.delete({ folderId });
  if (page.url.searchParams.get('folder') === folderId) {
    setSearchParam('folder', null);
    setSearchParam('note', null);
  }
},
```

Also remove `kv` from the `withActions` destructuring if no longer needed. If only `tables` is used, simplify:
```ts
.withActions(({ tables }) => ({ ... }))
```

#### 4. `apps/honeycrisp/src/lib/workspace/definition.ts` — Remove dead KV

Remove `selectedFolderId`, `selectedNoteId`, `sortBy` from KV definition. `sidebarCollapsed` has zero consumers (confirmed via grep) — remove it too. Remove entire `kv` block:

```ts
// Before:
export const honeycrisp = defineWorkspace({
  id: 'epicenter.honeycrisp' as const,
  tables: { folders: foldersTable, notes: notesTable },
  kv: {
    selectedFolderId: defineKv(FolderId.or(type('null')), null),
    selectedNoteId: defineKv(NoteId.or(type('null')), null),
    sortBy: defineKv(type("'dateEdited' | 'dateCreated' | 'title'"), 'dateEdited'),
    sidebarCollapsed: defineKv(type('boolean'), false),
  },
});

// After:
export const honeycrisp = defineWorkspace({
  id: 'epicenter.honeycrisp' as const,
  tables: { folders: foldersTable, notes: notesTable },
});
```

Remove `defineKv` import if unused.

#### 5. `apps/honeycrisp/src/lib/client.ts` — No changes needed

The workspace client still uses `workspace.tables`, `workspace.actions`, `workspace.kv` (if kv still exists). After removing kv from definition, `workspace.kv` no longer exists — any remaining references would be caught by TypeScript.

#### 6. Consumer components — No changes needed

All consumers read/write through `viewState.*` methods. Since the public API is preserved (same getter/setter names, same method signatures), components don't need changes. The backing store is transparent to them.

---

## App 2: Opensidian

### URL param mapping

| State | Param | Default (elided) | Type |
|---|---|---|---|
| `activeFileId` | `?file=<id>` | `null` (no file) | `FileId \| null` |
| `activeConversationId` | `?chat=<id>` | `''` (first conversation) | `ConversationId` |

**NOT moving (evaluation results):**
- `search-state.svelte.ts` — Command palette search. Ephemeral, has `reset()` on close. Not bookmarkable.
- `sidebar-search-state.svelte.ts` — Sidebar FTS. Preferences are persisted via `createPersistedState`. The search query is ephemeral. Panel view toggle (`leftPaneView`) is a layout preference. None of these benefit from URL params.
- `editor-state.svelte.ts` — Editor preferences (vim, cursor). Layout/runtime state.
- `terminal-state.svelte.ts` — Terminal session state. Not linkable.
- `skill-state.svelte.ts` — Runtime skill loader. Not linkable.

### Files to change

#### 1. `apps/opensidian/src/lib/url-state.ts` — New shared utility

Same `setSearchParam` utility as Honeycrisp, extracted to its own file:
```ts
import { goto } from '$app/navigation';
import { page } from '$app/state';

export function setSearchParam(key: string, value: string | null) { ... }
```

#### 2. `apps/opensidian/src/lib/state/fs-state.svelte.ts` — activeFileId migration

**Remove:** `let activeFileId = $state<FileId | null>(null);`

**Add imports:** `page` from `$app/state`, `setSearchParam` from `$lib/url-state`.

**Getter change:**
```ts
get activeFileId() {
  return (page.url.searchParams.get('file') as FileId) ?? null;
},
```

**Action changes:**
```ts
selectFile(id: FileId) {
  setSearchParam('file', id);
  openFileIds.add(id);
},

closeFile(id: FileId) {
  openFileIds.delete(id);
  if (page.url.searchParams.get('file') === id) {
    const next = [...openFileIds].at(-1) ?? null;
    setSearchParam('file', next);
  }
},
```

**deleteFile:** Replace `if (activeFileId === id) activeFileId = null;` with URL param clearing.

**Derived state updates** — replace references to the now-removed `activeFileId` variable:
```ts
const selectedNode = $derived.by(() => {
  const fileId = page.url.searchParams.get('file') as FileId | null;
  return fileId ? (filesMap.get(fileId) ?? null) : null;
});

const selectedPath = $derived.by(() => {
  const fileId = page.url.searchParams.get('file') as FileId | null;
  return fileId ? computePath(fileId) : null;
});
```

**startCreate** — replace `focusedId ?? activeFileId` with `focusedId ?? (page.url.searchParams.get('file') as FileId | null)`.

**Consumer components:** No changes needed — they all read `fsState.activeFileId` (the getter) and call `fsState.selectFile(id)`.

#### 3. `apps/opensidian/src/lib/chat/chat-state.svelte.ts` — activeConversationId migration

**Remove:** `let activeConversationId = $state<ConversationId>('' as ConversationId);`

**Add imports:** `page` from `$app/state`, `setSearchParam` from `$lib/url-state`.

**Read pattern:**
```ts
function getActiveConversationId(): ConversationId {
  return (page.url.searchParams.get('chat') ?? '') as ConversationId;
}
```

**Replace all reads of `activeConversationId` with `getActiveConversationId()`:**
- `reconcileHandles()` — read
- `workspace.whenReady.then(...)` — read
- `newConversation()` — read
- All `handles.get(activeConversationId)` — replace with `handles.get(getActiveConversationId())`

**Replace all writes of `activeConversationId = id` with `setSearchParam('chat', id)`:**
- `reconcileHandles()` line 303
- `workspace.whenReady.then(...)` lines 322, 330
- `newConversation()` line 351

**The `_unobserveChatMessages` observer** reads `activeConversationId` — replace with `getActiveConversationId()`.

**Consumer components:** No changes — they read `aiChatState.active` (which internally calls `handles.get(getActiveConversationId())`), never `activeConversationId` directly.

---

## Commit Strategy

Surgical, atomic commits per logical change:

### Honeycrisp (3 commits)
- [ ] **Commit 1:** `feat(honeycrisp): extract setSearchParam URL state utility` — Create `apps/honeycrisp/src/lib/url-state.ts`
- [ ] **Commit 2:** `feat(honeycrisp): migrate view state from KV/$state to URL search params` — Rewrite `view.svelte.ts`, update `notes.svelte.ts` and `folders.svelte.ts` KV calls, update `workspace.ts` mutation handler
- [ ] **Commit 3:** `chore(honeycrisp): remove dead KV definitions from workspace schema` — Clean up `definition.ts`, remove unused imports

### Opensidian (3 commits)
- [ ] **Commit 4:** `feat(opensidian): extract setSearchParam URL state utility` — Create `apps/opensidian/src/lib/url-state.ts`
- [ ] **Commit 5:** `feat(opensidian): migrate activeFileId to URL search params` — Update `fs-state.svelte.ts`
- [ ] **Commit 6:** `feat(opensidian): migrate activeConversationId to URL search params` — Update `chat-state.svelte.ts`

---

## Risks and edge cases

1. **`goto()` is async** — In SvelteKit with `replaceState: true` and no server load, the URL update is near-instant. But code that writes then immediately reads may see stale params. Mitigate by reading the value you just set from local scope, not from `page.url.searchParams`, within the same synchronous block.

2. **Circular deps** — `view.svelte.ts` imports `notesState` and `foldersState`. Those files must NOT import `viewState`. Use the shared `url-state.ts` utility instead.

3. **Workspace action context** — `defineMutation` handlers don't have access to SvelteKit's `page`. Selection clearing must happen in the Svelte layer, not in the mutation handler.

4. **Initial load** — When the page loads with `?note=abc123`, the note ID is immediately available via `page.url.searchParams`. No async init needed. But the workspace data might not be ready yet. Components already guard on `workspace.whenReady` / null checks.

5. **Chat reconciliation** — `reconcileHandles()` runs synchronously from observers. `setSearchParam()` calls `goto()` which may schedule a microtask. The handle lookup immediately after setting the param might not find the new conversation. Mitigate by using the ID value directly rather than re-reading from URL within the same function.

---

## Review

_To be filled after implementation._
