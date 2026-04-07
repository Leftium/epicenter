# Fuji

A local-first personal CMS. Create and manage entries with a collaborative rich-text editor; data lives in IndexedDB and syncs to the Epicenter API over WebSocket.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. MIT licensed.

---

## How it works

Fuji is a SvelteKit app (static adapter, SSR disabled) with three panels: a sidebar for filtering and search, a main area that toggles between table and timeline views, and an editor panel for rich-text content.

**Workspace schema** (`id: "epicenter.fuji"`)

The workspace holds all app state in a single Yjs document:

- `entries` table — each row has `id` (EntryId), `title`, `subtitle`, `type` (string[]), `tags` (string[]), `createdAt`, `updatedAt`, and `_v`. Each entry also carries an attached content document via `withDocument('content', { guid: 'id', onUpdate })`, which exposes a `Y.Text` instance bound to the ProseMirror editor via `y-prosemirror`.
- KV keys — `selectedEntryId`, `viewMode` (`'table' | 'timeline'`), `sidebarCollapsed`.

**Client wiring** (`src/lib/client.ts`)

```ts
createWorkspace(fujiWorkspace)
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({ url, getToken }))
```

Encryption keys are applied on login. Local data is cleared on logout.

**Editor**

ProseMirror with `y-prosemirror` binds directly to the entry's `Y.Text`. Edits are conflict-free by default; two sessions editing the same entry merge automatically.

**Keyboard shortcuts**

- `Cmd+N` — new entry
- `Escape` — deselect current entry

## Development

```sh
bun run dev:local     # vite dev on port 5174
bun run dev:remote    # vite dev --mode production (remote API)
bun run build         # NODE_ENV=production vite build
bun run typecheck     # svelte-kit sync && svelte-check
```

## License

MIT
