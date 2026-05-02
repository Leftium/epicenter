# Fuji

Fuji is a local-first CMS where every entry's body is its own CRDT. Write offline, sync later, and collaborate on a single entry without touching the rest of your content. Think of it as a structured journal, knowledge base, or portfolio, whatever you tag and type your entries as.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. MIT licensed.

---

## How it works

### Layout

SvelteKit app (static adapter, SSR disabled) with three panels: a sidebar for filtering by type, tags, and search; a main area that toggles between table and timeline views; and an editor panel for rich-text content.

### Data model

Workspace ID: `epicenter.fuji`. Rich-text content and entry metadata are separate CRDTs. The entries table stays lean: just IDs, titles, tags, timestamps. Each entry's body lives in its own Y.Doc opened by a `createBrowserDocumentFamily` keyed on the entry id; the child document builder owns the storage guid. Loading a list of 500 entries doesn't mean loading 500 rich-text trees; the editor and the list never contend for the same document.

- `entries` table: `id` (EntryId), `title`, `subtitle`, `type` (string[]), `tags` (string[]), `createdAt`, `updatedAt`, `_v`. Each entry's body is opened on demand from a per-row content-doc cache and bound to ProseMirror via `y-prosemirror`.
- KV keys: `selectedEntryId`, `viewMode` (`'table' | 'timeline'`), `sidebarCollapsed`.

### Client wiring

Fuji's root workspace is a singleton, not a factory. `openFuji()` owns the `new Y.Doc(...)` call, composes every attachment inline, and returns the bundle directly. Auth transitions are handled in the client singleton with `bindAuthWorkspaceScope(...)`, so encryption keys, local cleanup, and sync reconnects follow one transition path.

```ts
export function openFuji() {
  const ydoc = new Y.Doc({ guid: 'epicenter.fuji', gc: false });

  const encryption = attachEncryption(ydoc);
  const tables = encryption.attachTables(ydoc, fujiTables);
  const kv = encryption.attachKv(ydoc, {});
  const awareness = attachAwareness(ydoc, {});

  const idb = attachIndexedDb(ydoc);
  attachBroadcastChannel(ydoc);
  const sync = attachSync(ydoc, {
    url: toWsUrl(`${APP_URLS.API}/workspaces/${ydoc.guid}`),
    waitFor: idb.whenLoaded,
    getToken: async () => {
      await auth.whenLoaded;

      const snapshot = auth.snapshot;
      return snapshot.status === 'signedIn' ? snapshot.session.token : null;
    },
  });

  return {
    get id() { return ydoc.guid; },
    ydoc, tables, kv, awareness, encryption, idb, sync,
    whenLoaded: idb.whenLoaded,
    [Symbol.dispose]() {
      ydoc.destroy();
    },
  };
}

export const workspace = openFuji();
```

`bundle.id` is a getter over `ydoc.guid`, so there is only one source of truth. The browser bundle exposes concrete resources like `idb`, `sync`, and child document collections. Auth state flows through `auth.snapshot` and `bindAuthWorkspaceScope` in `apps/fuji/src/lib/fuji/client.ts`, where the app composes sync pause, key application, reconnect, and local reset policy.

For a sibling example of the same pattern (plus a Tauri-side materializer), see `apps/whispering/src/lib/client.ts`.

### Editor

ProseMirror with `y-prosemirror` binds directly to the entry's `Y.Text`. Edits are conflict-free by default; two sessions editing the same entry merge automatically.

### Keyboard shortcuts

- `Cmd+N`: new entry
- `Escape`: deselect current entry

---

## Development

Prerequisites: [Bun](https://bun.sh).

```bash
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
cd apps/fuji
bun dev
```

By default this runs against a local dev server on port 5174. To run against the production sync server:

```bash
bun run dev:remote
```

---

## Tech stack

- [SvelteKit](https://kit.svelte.dev): UI framework (static adapter, SSR disabled)
- [ProseMirror](https://prosemirror.net) + [y-prosemirror](https://github.com/yjs/y-prosemirror): collaborative rich-text editing
- [TanStack Svelte Table](https://tanstack.com/table): entry list table view
- [Yjs](https://yjs.dev): CRDT engine
- [Tailwind CSS](https://tailwindcss.com): styling
- `@epicenter/workspace`: CRDT-backed tables, versioning, documents
- `@epicenter/auth-svelte`: auth snapshot wrapper
- `@epicenter/svelte`: workspace gate and reactive table/KV bindings
- `@epicenter/ui`: shadcn-svelte component library

---

## License

MIT
