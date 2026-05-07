# Fuji

Fuji is a local-first CMS where every entry's body is its own CRDT. Write offline, sync later, and collaborate on a single entry without touching the rest of your content. Think of it as a structured journal, knowledge base, or portfolio, whatever you tag and type your entries as.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. MIT licensed.

---

## How it works

### Layout

SvelteKit app (static adapter, SSR disabled) with three panels: a sidebar for filtering by type, tags, and search; a main area that toggles between table and timeline views; and an editor panel for rich-text content.

### Data model

Workspace ID: `epicenter.fuji`. Rich-text content and entry metadata are separate CRDTs. The entries table stays lean: just IDs, titles, tags, timestamps. Each entry's body lives in its own Y.Doc opened by a `createDisposableCache` keyed on the entry id; the child document builder owns the storage guid. Loading a list of 500 entries doesn't mean loading 500 rich-text trees; the editor and the list never contend for the same document.

- `entries` table: `id` (EntryId), `title`, `subtitle`, `type` (string[]), `tags` (string[]), `createdAt`, `updatedAt`, `_v`. Each entry's body is opened on demand from a disposable cache and bound to ProseMirror via `y-prosemirror`.
- KV keys: `selectedEntryId`, `viewMode` (`'table' | 'timeline'`), `sidebarCollapsed`.

### Client wiring

Fuji's root workspace is built once per signed-in session by `createSession`. `openFuji()` owns the `new Y.Doc(...)` call, composes every attachment inline, and returns the bundle directly. The session module captures `userId` once at build time (since IDB and BroadcastChannel keys are immutable for the workspace's lifetime) and passes `bearerToken` and `encryptionKeys` as lazy callbacks that read from `auth.state` at use time, so token rotation and same-user key rotation propagate without a mutation hook on the workspace.

```ts
export function openFuji({
  userId,
  peer,
  bearerToken,
  encryptionKeys,
}: {
  userId: string;
  peer: PeerIdentity;
  bearerToken?: () => string | null;
  encryptionKeys: () => EncryptionKeys;
}) {
  const doc = openFujiDoc({ encryptionKeys });
  const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
  attachOwnedBroadcastChannel(doc.ydoc, { userId });
  const awareness = attachAwareness(doc.ydoc, {
    schema: { peer: PeerIdentity },
    initial: { peer },
  });
  const sync = attachSync(doc, {
    url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
    waitFor: idb,
    bearerToken,
    awareness,
  });
  return { ...doc, idb, awareness, sync };
}
```

The browser bundle exposes concrete resources like `idb`, `sync`, and child document collections. Auth state flows through `session.current`; the signed-in variant owns the browser workspace, and pages reach it via the module-level `getSignedInSession()` exported from `$lib/session.svelte` (throws if called outside the signed-in branch). Local cleanup is a separate explicit action, not part of sign-out.

For a sibling example of the same pattern (plus a Tauri-side materializer), see `apps/whispering/src/lib/whispering/client.ts`.

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
- `@epicenter/auth-svelte`: Svelte 5 wrapper around `@epicenter/auth`
- `@epicenter/svelte`: workspace gate and reactive table/KV bindings
- `@epicenter/ui`: shadcn-svelte component library

---

## License

MIT
