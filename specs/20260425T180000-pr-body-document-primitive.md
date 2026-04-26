# refactor: workspace primitive collapse, package consolidation, CLI redesign

**Status**: ready to paste at finalize time

> This document is the PR body for #1705. After paste via `gh pr edit 1705 --body-file ...` and after merge, **delete this file** — GitHub becomes the source of truth. Per the post-merge convention: scaffolding files (PR body drafts, execution prompts, in-flight trackers) get deleted; durable artifacts (architecture specs, skills, articles) stay.

---

This branch deletes `defineWorkspace` and the `withExtension` chain that drove every workspace in the codebase for a year. The terminal API is **`attach*` primitives composed inline against a Y.Doc the caller owns** — no builder, no extension slots, no framework-imposed bundle shape. Domain shapes emerge in the caller; the framework just provides composable verbs.

```ts
// Before
const workspace = createFujiWorkspace()
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({ url, getToken }));

// After
const ydoc = new Y.Doc({ guid: 'epicenter.fuji', gc: false });
const encryption = attachEncryption(ydoc);
const tables = encryption.attachTables(ydoc, fujiTables);
const kv = encryption.attachKv(ydoc, {});
const awareness = attachAwareness(ydoc, {});
const actions = createFujiActions(tables);
const idb = attachIndexedDb(ydoc);
const sync = attachSync(ydoc, {
  url, waitFor: idb.whenLoaded, awareness: awareness.raw,
  getToken: () => auth.getToken(),
  dispatch: (method, input) => dispatchAction(actions, method, input),
});
```

The chain wasn't doing real work. Each `.withExtension(name, factory)` call was a typed closure with extra ceremony to make the extension's exports reachable through the framework's generic shape. Once you have a Y.Doc as a local variable, `attachIndexedDb(ydoc)` is shorter and exposes its own typed handle (`idb.whenLoaded`, `idb.clearLocal`) without traveling through a slot. Sync wiring that referenced both persistence (`waitFor: idb.whenLoaded`) and awareness was contorted under the chain. It reads naturally under closures.

The framework collapsed with the chain. `Document` (a structural contract for "what a workspace returns"), `DocumentBundle`, `DocumentHandle` (a refcounted brand around bundles), `DocumentFactory`, `createDocumentFactory`, `defineDocument`, `defineWorkspace`, `ActionIndex` (a flat map of branded actions walked from arbitrary bundles), `iterateActions`, `ACTION_BRAND` (the symbol that made the walk possible), `entry.handle` envelope in the CLI loader — all gone. What's left is the smallest set of primitives that can build everything those layers were built to do, plus one piece of factory-shaped infrastructure (`createDisposableCache`) that survived because it does work the caller can't trivially do inline: refcount + grace-period teardown for any `Disposable`. Y.Docs are the most common case in this codebase; audio decoders, worker connections, and Tauri webview handles fit the same shape.

The package surface follows the API. `@epicenter/yjs-doc` got renamed to `@epicenter/document`; `@epicenter/document` got merged wholesale into `@epicenter/workspace`. One published surface, one barrel, one place to find anything. `@epicenter/auth` split into framework-agnostic core + Svelte wrapper because `createAuth` was Svelte-coupled and unusable from Node tooling.

Apps composed on the new primitives end up in three files per app — iso doc factory, env factory, singleton + lifecycle — because once you have a portable iso layer, build configs and Node tooling can construct the doc without dragging in `y-indexeddb` or `BroadcastChannel`. That's the iso/env/client convention codified at `.claude/skills/workspace-app-layout/SKILL.md`.

**520 commits, 534 files, +37,672 / -23,256, 19 packages/apps touched.** Single PR because most of the work is structurally coupled — you can't delete `Document` without rewriting the CLI loader, you can't split `@epicenter/auth` without migrating six apps' session subscriptions, you can't move actions to passthrough without touching every Result-consuming call site.

There is no follow-up cleanup PR for shapes introduced here. Two additive layers (awareness publishing, CLI cross-device dispatch) ship as separate PRs after this one merges. Architecture for those lives at `specs/20260425T000000-device-actions-via-awareness.md`.

---

## How to read this PR

If you only have an hour, read these five commits in order — they're the spine:

- `830a7ef8c` — **WebSocket subprotocol auth.** The wire-protocol pivot Section 1 builds on. Tokens leave URLs.
- `b62cc5ae3` — **delete `createWorkspace` + extension chain.** The moment the original builder dies, after every consumer migrated to closure-composed `attach*`.
- `3dec00926` — **`attachSync` takes `dispatch:` and `getToken:` callbacks.** Replaces `setToken`/`requiresToken`/`serveRpc`/IIFE token bootstrap. The clean-shape pivot for the transport boundary.
- `814965d10` — **`createDocumentFactory` → `createDisposableCache`.** The framework primitive stripped to its honest contract: a refcount cache for anything `Disposable`. `Document`, `DocumentHandle`, `DOCUMENT_HANDLE`, `iterateActions`, `ActionIndex` all go in the same wave.
- `8f46308e9` — **iso/env/client three-file layout codified.** The seam between iso construction and env binding that made workspace exports importable from Node tooling without dragging IndexedDB.

Everything else is variation on those five.

The 13 sections below cover what shipped. If you want narrative instead of reference, the article `docs/articles/workspaces-were-documents-all-along.md` walks the v1→v5 arc end-to-end.

---

## 1. WebSocket subprotocol auth

Better Auth sessions default to seven days. We were appending those tokens as `?token=...` to every WebSocket URL, which means every token we'd ever issued was sitting in Cloudflare Logpush, readable until session expiry. Browser history had them. Every observability pipeline had them.

The fix uses RFC 6455's subprotocol channel. The browser `WebSocket` constructor accepts a list of subprotocols, the `Sec-WebSocket-Protocol` header is just ASCII tokens, and headers aren't in default log fields.

```ts
// Before
const ws = new WebSocket(`${url}?token=${token}`);

// After — bearer rides as a subprotocol; only `epicenter` is echoed on 101
const ws = new WebSocket(url, [MAIN_SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${token}`]);
```

The server reads the bearer entry and synthesizes an `Authorization` header for Better Auth. The DO echoes only `epicenter` to complete the handshake; the bearer entry never round-trips. Constants and parse helpers live in `@epicenter/sync/auth-subprotocol` so the client (`packages/workspace/src/document/attach-sync.ts`), the Hono middleware (`apps/api/src/app.ts`), and the upgrade handler (`apps/api/src/base-sync-room.ts`) all read the same definition.

**Article**: `docs/articles/tokens-dont-belong-in-urls.md` covers what we missed for months and how to think about token-in-URL patterns generally.

**Keystone**: `830a7ef8c`.

---

## 2. Session writer partition (token rotation race)

Two writers were updating the session record. The auth interceptor's `onSuccess` handler writes rotated tokens. `useSession.subscribe` writes the full enriched session from `/auth/get-session`. Either could fire first. Token T2 lands via rotation, then a stale T1 emits from the async refetch and clobbers it.

The fix partitions ownership by field. `useSession` always owns `user` and `encryptionKeys`. For `token`, it preserves the current value if one exists (rotation may have written a fresher one) and only falls back to BA's value when establishing initial state:

```ts
session.set({
  ...current,
  user: next.user,
  encryptionKeys: next.encryptionKeys,
  token: current?.token ?? next.token,
});
```

A same-token guard on `onSuccess` skips the write when the server echoes an unchanged token, so non-rotating requests don't fan out subscribers. `signOut` now returns `Result<undefined, SignOutFailed>` like every other auth method — previously it swallowed errors via `console.error`.

**Keystones**: `e3b2a38b8`, `d11ae8e00`, `ff852c3c2`, `e2f7ed3c9`.

---

## 3. Package consolidation

Two separate consolidations, both load-bearing for everything else.

### `@epicenter/auth` split into core + svelte

`createAuth` was Svelte-coupled — it took a Svelte store as `session` and called `useSession.subscribe` from the framework's runtime. That made auth unusable in Node tools, the CLI, and any non-Svelte consumer. The split:

- `@epicenter/auth` — core. Framework-agnostic `createAuth(...)` over a `SessionStore` contract.
- `@epicenter/auth-svelte` — Svelte wrapper. Spreads core methods, exposes the reactive session, adapts `SessionStore` to a Svelte rune store.

Migration ran as seven sequential commits (`9a066780d` → `808e9bfb2`), one step per concern: scaffold the package shell, move auth-types, define `SessionStore` contract, port `createAuth` core, ship the Svelte wrapper, migrate six apps, delete the old `svelte-utils/auth`. Every app's `client.ts` ends up importing from `@epicenter/auth-svelte`.

### `@epicenter/yjs-doc` → `@epicenter/document` → merged into `@epicenter/workspace`

The CRDT primitives lived in three packages chasing the same boundary. `yjs-doc` got renamed to `document` (`2a012c087`); `document` got merged wholesale into `workspace` (`a7547cd5e` migrates consumers; `11efb21ed` deletes the package). The boundary survives as `packages/workspace/src/document/` — directory, not package. One published surface, one barrel, one place to find anything.

**Keystones**: `9a066780d` (auth split), `11efb21ed` (document package deleted), `a7547cd5e` (consumers migrated).

---

## 4. Workspace primitive: terminal shape

The framework collapsed from `defineWorkspace().withExtension(...)` chains down to plain `attach*` calls against a Y.Doc the caller owns. The history of how it got there is in the article; the **terminal contract** is:

- A workspace is whatever a `open<App>(...)` factory returns.
- It must own a `Y.Doc`, expose `[Symbol.dispose]`, and (if anything is async) a `whenReady: Promise<unknown>`.
- Beyond that, the shape is the caller's choice.

There is no `Document` structural type, no `DocumentHandle` brand, no `DocumentBundle`, no `createDocumentFactory`, no `defineWorkspace`, no extension chain.

What survived from the old framework:

```
attachTables, attachKv, attachAwareness         (data primitives)
attachIndexedDb, attachSqlite                   (persistence)
attachBroadcastChannel, attachSync              (transport)
attachEncryption, attachSessionUnlock           (crypto)
attachMarkdownMaterializer, attachSqliteMaterializer  (derived stores)
attachRichText, attachPlainText, attachTimeline (editor bindings)
defineTable, defineKv                           (schemas)
defineQuery, defineMutation, dispatchAction     (actions)
createDisposableCache                           (refcount cache; opt-in)
```

**`createDisposableCache`** is the one piece of "factory-shaped infrastructure" that survived — and it survived because it does real work the caller can't easily do inline. Multiple components mounting the same per-row content doc need to share one Y.Doc; rapid entry-A→entry-B→entry-A clicks shouldn't thrash IndexedDB. The cache solves that for any `Disposable` resource:

```ts
export interface DisposableCache<Id, T> extends Disposable {
  open(id: Id): T & Disposable;
  has(id: Id): boolean;
}

export function createDisposableCache<
  Id extends string | number,
  T extends Disposable,
>(
  build: (id: Id) => T,
  opts?: { gcTime?: number },  // default 5_000ms
): DisposableCache<Id, T>;
```

Y.Docs satisfy `Disposable`. Audio decoders satisfy it. Tauri webview handles satisfy it. The cache doesn't know which.

For workspace singletons (one per app, lives for the app's lifetime), `createDisposableCache` is overkill — those just live at module scope. For per-row docs (Fuji entries, Honeycrisp notes), the cache is wired inline in the env factory.

**Keystones**: `b62cc5ae3` (createWorkspace dies), `814965d10` (cache renamed and stripped), `d2c375158` (iterateActions dropped from public API).

---

## 5. App layout: iso/env/client three-file convention

Once the framework collapsed to plain composition, every app put its workspace in one file (`client.svelte.ts`) at module scope. That worked until a Node consumer (build config, codegen, test fixture) needed to construct the workspace's Y.Doc without dragging in `y-indexeddb`, `BroadcastChannel`, or `chrome.*` globals. The single-file shape couldn't be split because identity, bindings, and singleton-with-side-effects were the same module statements.

The fix is structural — three files per app:

```
apps/<app>/src/lib/<app>/
├── index.ts       ← iso doc factory      open<App>()
├── <binding>.ts   ← env factory          open<App>({ deps })
└── client.ts      ← singleton + auth + lifecycle
```

| File | Imports | Returns | Side effects |
|---|---|---|---|
| `index.ts` | `@epicenter/workspace` core, schemas | doc bundle (ydoc, tables, kv, encryption, actions, batch, dispose) | none |
| `<binding>.ts` | `./index` + env-specific `attach*` | doc + env resources (idb, sync, materializers, caches) | none |
| `client.ts` | `./<binding>` + `createAuth` | `auth` + singleton + lifecycle subscriptions | createAuth, singleton, onSessionChange, HMR |

Binding name follows the actual platform: `browser.ts` (zhongwen, fuji, honeycrisp, opensidian), `extension.ts` (tab-manager), `tauri.ts` (whispering). Cross-environment imports are rejected by convention — siblings never import each other; they compose only through `index.ts`.

Fuji's terminal shape (`apps/fuji/src/lib/fuji/`):

```ts
// index.ts
export function openFuji() {
  const ydoc = new Y.Doc({ guid: 'epicenter.fuji', gc: false });
  const encryption = attachEncryption(ydoc);
  const tables = encryption.attachTables(ydoc, fujiTables);
  const kv = encryption.attachKv(ydoc, {});
  const awareness = attachAwareness(ydoc, {});
  const actions = createFujiActions(tables);
  return {
    ydoc, tables, kv, encryption, awareness, actions,
    batch: (fn: () => void) => ydoc.transact(fn),
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}

// browser.ts
export function openFuji({ auth }: { auth: AuthClient }) {
  const doc = openFujiDoc();
  const idb = attachIndexedDb(doc.ydoc);
  attachBroadcastChannel(doc.ydoc);
  const entryContentDocs = createDisposableCache(
    (entryId: EntryId) => createEntryContentDoc({ entryId, /* ... */ auth }),
    { gcTime: 5_000 },
  );
  const sync = attachSync(doc.ydoc, {
    url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
    waitFor: idb.whenLoaded,
    awareness: doc.awareness.raw,
    getToken: () => auth.getToken(),
    dispatch: (action, input) => dispatchAction(doc.actions, action, input),
  });
  return { ...doc, idb, entryContentDocs, sync, whenReady: idb.whenLoaded };
}

// client.ts
const session = createPersistedState({ key: 'fuji:authSession', /* ... */ });
export const auth = createAuth({ baseURL: APP_URLS.API, session });
export const fuji = openFuji({ auth });

auth.onSessionChange((next, previous) => {
  if (next === null) {
    fuji.sync.goOffline();
    if (previous !== null) void fuji.idb.clearLocal();
    return;
  }
  fuji.encryption.applyKeys(next.encryptionKeys);
  if (previous?.token !== next.token) fuji.sync.reconnect();
});
```

Six apps migrated: fuji, honeycrisp, opensidian, zhongwen, tab-manager, whispering. The convention is codified at `.claude/skills/workspace-app-layout/SKILL.md`.

**Keystones**: `8f46308e9` (skill), `2cc080bd0` → `fcf6de7d2` (per-app rollout, six commits).

---

## 6. Encryption coordinator + encrypted CRDT primitives

`attachEncryption` became a coordinator that exposes `.attachTables` / `.attachKv` methods directly. The form makes it visually clear that encryption is applied first as a stateful container, and tables/kv are wired through it:

```ts
const encryption = attachEncryption(ydoc);
const tables = encryption.attachTables(ydoc, fujiTables);
const kv = encryption.attachKv(ydoc, {});
encryption.applyKeys(session.encryptionKeys);
```

Underneath: encrypted variants of `YKeyValueLww` and friends live in `packages/workspace/src/document/encrypted-*`, with a `register()` coordinator pattern that lets `attachEncryption` introspect what's been wired and apply keys uniformly. Key rotation upgrades old-version ciphertext on `applyKeys` (`06014afa5`) — no separate re-encrypt pass.

**Keystones**: `49ff94d60` (coordinator pattern), `f98d2c214` (terminal shape), `06014afa5` (rotation upgrades).

---

## 7. Materializer subsystem

Two new attaches that mirror Yjs table state to external stores:

```ts
// SQLite mirror — for fast indexed reads, FTS5 search
attachSqliteMaterializer(ydoc, { db: new Database('workspace.db'), waitFor })
  .table(tables.entries, { fts: ['title', 'body'] })
  .table(tables.tags);

// Markdown mirror — for human-readable export, git workflows
attachMarkdownMaterializer(ydoc, { dir: './data', waitFor })
  .table(tables.entries, {
    filename: slugFilename('title'),
    toMarkdown: ({ row }) => stringifyEntryMd(row),
    fromMarkdown: ({ md }) => parseEntryMd(md),
  })
  .kv(kv);
```

Both are one-way (workspace → store); both register `ydoc.once('destroy', ...)` so destroying the ydoc tears down the mirror; both expose `whenFlushed` for tests. Markdown materializer supports a `rebuild` mode for orphan cleanup. SQLite materializer's `rebuild` matches the sqlite materializer's parity convention.

The `@epicenter/skills` package uses these for disk-round-trip of agent skill definitions (`importFromDisk` / `exportToDisk` actions in `packages/skills/src/node.ts`).

**Keystones**: `9383ed707` (spec), the materializer subdirectory at `packages/workspace/src/document/materializer/`.

---

## 8. Structured logger + JSONL sink

Replaced ad-hoc `console.*` calls across the workspace package with `wellcrafted/logger` — a typed-error logger with five levels (trace/debug/info/warn/error) and dependency-injected sinks. Warn/error levels carry structured error variants, not free-form strings.

A new Bun-only sink, `jsonlFileSink`, writes structured records to a JSONL file via `Bun.file(path).writer()`. Lives at `packages/workspace/src/shared/logger/jsonl-sink.ts` because it can't run in browsers; the logger core itself is platform-agnostic and imported from `wellcrafted/logger`.

Every previously-`console.*` site in the workspace package now has a typed error variant (`AttachSyncError.PingTimeout`, `BroadcastChannelError.SerializeFailed`, etc.) defined via `defineErrors`. Skill at `.claude/skills/logging/SKILL.md`.

**Keystones**: `76f0ee1b0` (logger core), `8caced5e0` (JSONL sink), `19342b5d7` (console.* migration).

---

## 9. Action surface: passthrough handlers, Result envelope at boundaries

Local handlers used to be free to return whatever they wanted: a raw value, a Promise, a `Result`, a thrown exception. The wire couldn't propagate that — thrown errors don't cross processes, and the type machinery to merge "raw return" with "Result return" with "ActionFailed on the wire" was a `RemoteReturn<T>` conditional type doing real work.

We collapsed it once, then walked half of it back. Terminal shape:

- **Local actions are passthrough.** `defineMutation({ handler: ... })` returns the handler verbatim with metadata attached. Sync stays sync, raw stays raw, `Result` if explicit. Local callers see exactly what the author wrote.
- **The wire boundary normalizes.** Generic in-process consumers (AI tool bridge, CLI dispatch, RPC server-side) call `invokeNormalized(action, input, label)` to get uniform `Promise<Result<T, RpcError>>`. Thrown handlers become `Err(ActionFailed)`. Raw values get `Ok`-wrapped.
- **Remote callables get the wrapped shape via the type system.** `WrapAction<F>` flattens the four possible handler return shapes into one `Promise<Result<T, E | RpcError>>`; `RemoteActions<A>` mirrors an action tree's structure with each leaf wrapped.

```ts
// Local — passthrough; whatever the handler returns
fuji.actions.entries.create({ title: 'hi' })
  // → whatever createMutation's handler returns (likely { id: EntryId } raw)

// AI bridge — normalized
const result = await invokeNormalized(action, input, 'entries.create');
if (result.error) throw result.error;
return result.data;

// Remote — typed as wrapped
const result = await remote.entries.create({ title: 'hi' });
//      Promise<Result<{ id: EntryId }, ActionFailed | RpcError>>
```

`ACTION_BRAND` is gone (`isAction(v)` is now structural). `RemoteReturn<T>` is gone. `iterateActions` was inlined into its sole live caller and dropped from the public API. `dispatchAction(actions, path, input)` resolves a dot-path against an action tree and invokes — replaces the old `ActionIndex.get(path)` lookup.

`ActionFailed` is now a type alias over `@epicenter/sync`'s `RpcError.ActionFailed`. One nominal type; no nesting; `isRpcError` works across boundaries.

**ADR**: `specs/20260425T200000-actions-passthrough-adr.md` documents why we walked back the always-Result decision after one day of integration.

**Keystones**: `fd3a1ce8d` (drop ACTION_BRAND), `81cd627ee` (defineMutation/defineQuery passthrough), `2be551876` (invokeNormalized), `81bdadb04` (unify ActionFailed).

---

## 10. CLI: scripting-first, three commands

The CLI was written against the old `createWorkspace()` shape, where every workspace had `.tables`, `.kv`, `.actions`, `.extensions` available. After the primitive collapse, a workspace export guarantees only `{ ydoc, [Symbol.dispose] }` plus whatever the author chose to expose. Eight of the eleven commands (`get`/`list <table>`/`count`/`delete`/`tables`/`kv`/`size`/`rpc`/`start`/`init`/`describe`) speculated on structure the contract no longer carries.

Rather than reinvent CRUD-by-flag for each consumer's bundle shape, the CLI shrinks to what scripts can't do:
- Manage interactive auth sessions
- Introspect what's runnable
- Dispatch a single branded action, locally or to a peer
- Snapshot remote presence

Anything else: write a `.ts` script that imports `epicenter.config.ts` and calls the typed handle directly. `bun run scripts/foo.ts` is the runtime.

```
                Local            Remote
              ┌─────────┬─────────────────┐
  Enumerate   │  list   │  peers          │
  Invoke      │  run    │  run --peer     │
              └─────────┴─────────────────┘

  Cross-cutting: auth (server session, pre-workspace)
```

```
BEFORE (11 commands)                   AFTER (3 + auth)
auth { login/logout/status }    keep   auth { login/logout/status }
start                           drop   list  [dot.path]    new
get/list/count/delete <table>   drop   run   <dot.path>    rewritten
tables / kv / size / rpc        drop   peers               new
export / init / describe        drop
run <action>                 rewrite
```

Invocation:

```bash
$ epicenter run fuji.entries.create '{"title":"Hi","body":"..."}'
{ "id": "01HW..." }

$ cat payload.json | epicenter run fuji.entries.create
$ epicenter run fuji.entries.create @payload.json
$ epicenter run fuji.entries.list --peer deviceName=alice-laptop
```

**JSON-only input.** Three sources, all routed through `parseJsonInput`: positional (`'{...}'` or `@file.json`), stdin pipe, or `--peer` payload. The previous `typeboxToYargsOptions` flag-mapper is gone — flat-flag input was a leaky escape hatch that fell over on nested objects, arrays, and any flag colliding with yargs built-ins like `--help`. One input shape across local and remote.

`peers` is a one-shot snapshot of remote awareness. You don't appear in your own list.

```bash
$ epicenter peers
clientID  client     deviceName     since
8392114   chrome-ext alice-laptop   3s ago
1029384   epicenter  bob-mbp        18s ago
```

**Exit codes carry meaning for scripts.** `1` usage or setup error, `2` action returned `Err` or remote RPC failed, `3` peer didn't resolve within `--wait`. The split between `2` and `3` lets a script retry on `3` (transient) without retrying on `2` (real failure).

`peers` defaults to `--wait 0`. `run --peer` defaults to `--wait 5000` (resolve target + complete RPC).

**`attachSessionUnlock`** is a new primitive in `packages/cli/src/auth/`. Thin wrapper over `attachEncryption` that sources keys from the CLI session store — the one piece a CLI-mode workspace can't synthesize from the workspace package alone. It exposes `whenChecked: Promise<unknown>` so `attachSync({ waitFor: ... })` can compose with it the same way it composes with persistence.

CLI loader returns `{ entries: Array<{ name, workspace }>, dispose }`. Commands read first-class fields off `entry.workspace` (no `entry.handle.X` envelope, no duck-typed `getSync`/`extractAwareness` helpers).

**Article**: `docs/articles/you-already-built-cqrs.md` covers why writes flow through Yjs as state and reads/queries dispatch through addressable `defineQuery`/`defineMutation` nodes — CQRS without anyone planning it.

**Keystones**: `db4a8c4e5` (schema-to-yargs flag bridge removed), `a56369aac` (peers + remote dispatch), `c1ee2e853` (exit codes + `--wait` rename), `3366fe3a9` (handle/ActionIndex → workspace/walkActions).

---

## 11. Per-row content docs

Fuji entries and Honeycrisp notes have rich-text bodies stored in their own per-row Y.Docs (split-pane editors, preview tiles, rapid entry-switching all need the same doc shared). The terminal shape is a **pure singular builder** wrapped in a `createDisposableCache` at the workspace's env layer:

```ts
// apps/fuji/src/lib/entry-content-docs.ts — pure builder
export function createEntryContentDoc({
  entryId, workspaceId, entriesTable, auth, apiUrl,
}: {
  entryId: EntryId;
  workspaceId: string;
  entriesTable: Table<Entry>;
  auth: Pick<AuthCore, 'getToken'>;
  apiUrl: string;
}): EntryContentDoc {
  const ydoc = new Y.Doc({ guid: docGuid({ workspaceId, collection: 'entries', rowId: entryId, field: 'content' }), gc: false });
  const body = attachRichText(ydoc);
  const idb = attachIndexedDb(ydoc);
  attachSync(ydoc, { url: toWsUrl(`${apiUrl}/docs/${ydoc.guid}`), waitFor: idb.whenLoaded, getToken: () => auth.getToken() });
  onLocalUpdate(ydoc, () => entriesTable.update(entryId, { updatedAt: DateTimeString.now() }));
  return { ydoc, body, whenReady: idb.whenLoaded, [Symbol.dispose]() { ydoc.destroy(); } };
}

// apps/fuji/src/lib/fuji/browser.ts — cache wired inline
const entryContentDocs = createDisposableCache(
  (entryId) => createEntryContentDoc({ entryId, workspaceId: doc.ydoc.guid, entriesTable: doc.tables.entries, auth, apiUrl: APP_URLS.API }),
  { gcTime: 5_000 },
);
```

Components consume via `fromDisposableCache(entryContentDocs, () => entry.id)` — a Svelte adapter in `@epicenter/svelte` that bridges the cache to `$derived` + `$effect` lifecycle. Replaces the old `fromDocument(handle)` which carried framework-specific `Document` types.

Honeycrisp's note bodies follow the same shape (`createNoteBodyDoc` + cache).

**Keystones**: `b4ef57db9` (singular pure builders), `2f4c93fec` (`fromDocument` → `fromDisposableCache`).

---

## 12. Tab-close safety net (commit-on-blur)

Fuji's title and subtitle fields commit on blur (not on every keystroke) for editing comfort. That's correct for in-tab editing but loses the in-flight edit if the user closes the tab mid-edit. The fix wires `svelte:document` to `visibilitychange` and (per the article — `pagehide` is a window event, not a document event) `window pagehide`, flushing pending state through the same `updateEntry` action that handles blur. Both events fire reliably across browser variants and don't suffer the unload-event deprecation.

**Article**: `docs/articles/commit-on-blur-survives-tab-close.md`. **Skill**: `.claude/skills/commit-on-blur/SKILL.md`.

**Keystones**: `9261b2d1a`, `e43699600`, `d25f6a521`, `1016de9be`.

---

## 13. Articles in this PR

Twenty articles, written or substantially revised. The narrative-driven ones (load these first if you only have time for a few):

- `workspaces-were-documents-all-along.md` — full v1 → v5 arc of the workspace primitive. The longest and the most comprehensive narrative.
- `tokens-dont-belong-in-urls.md` — Section 1's cover story.
- `you-already-built-cqrs.md` — Section 9/10's framing.
- `commit-on-blur-survives-tab-close.md` — the visibilitychange + .blur pattern.
- `20260422T160000-sync-dispose-cascade.md` — how `ydoc.destroy()` cascades cleanup through every attachment.

Pattern / lesson articles (referenced from skills):

- `singular-wrappers-delegate-to-plural.md`
- `reactive-touch-is-a-missing-subscription.md`
- `svelte-effect-root-hmr-pattern.md`
- `ok-null-is-fine-err-null-is-a-lie.md`
- `i-built-the-svelte-wrapper-first.md`
- `dont-export-everything.md`
- `callable-actions-pattern.md`
- `your-data-is-probably-a-table-not-a-file.md`
- `typescript-circular-inference.md`
- `yjs-abstraction-leaks-cost-more-than-the-abstraction.md`
- `why-tanstack-ships-separate-framework-packages.md`
- `20260420T160000-state-handle-null-is-the-component-lifecycle-in-disguise.md`
- `20260423T090839-query-params-leak-subprotocols-dont.md`

Plus refreshed: `20251001T180000-plugins-to-workspaces.md`, `20260127T120000-static-workspace-api-guide.md`.

---

## What's NOT in this PR

Two architectural layers are specced but deferred to follow-up PRs:

- **Awareness publishing** (`specs/20260425T000000-device-actions-via-awareness.md` Phase 1) — `serializeActionManifest`, `invoke`, awareness state convention, app wiring to publish offers. Builds on the post-teardown action registries + the `dispatch:` callback shape. No new attach primitive.
- **CLI cross-device dispatch** (same spec, Phase 3) — `epicenter devices` command, dot-prefix run resolution (`epicenter run desktop-1.action.path`). Builds on the awareness convention.

Both are additive to PR-A's terminal shapes — they don't break anything established here. They land as separate PRs after this one merges so their implementation prompts can be drafted against real merged code.

---

## Test plan

- [ ] `bun run typecheck` clean across the monorepo
- [ ] `bun test` passes in `packages/workspace` (553 tests), `packages/cli` (19 e2e), `packages/auth`, `packages/auth-svelte`, `packages/sync`, `packages/filesystem`, `packages/skills`
- [ ] All six apps cold-boot, hydrate, write end-to-end:
  - [ ] **fuji**: anonymous boot, sign in, create entry, edit body, sign out clears local data
  - [ ] **honeycrisp**: editor mounts via `fromDisposableCache`, survives rapid component remount
  - [ ] **opensidian**: `fs.read` / `fs.write` actions work; SQLite index search returns results
  - [ ] **tab-manager**: chrome.storage hydrates; `tabs.search` and `tabs.close` round-trip
  - [ ] **whispering**: Tauri loads; recordings materializer flushes to disk
  - [ ] **zhongwen**: cards CRUD + KV-backed app state
- [ ] Two-tab editing on Fuji + Honeycrisp shows CRDT propagation (no regression from refcount-cache extraction)
- [ ] Rapid entry-A → entry-B → entry-A clicks reuse the cached doc (no IndexedDB rehydrate flash)
- [ ] CLI commands work end-to-end:
  - [ ] `epicenter list` enumerates actions
  - [ ] `epicenter run fuji.entries.create '{...}'` round-trips
  - [ ] `epicenter peers` shows remote devices
  - [ ] `epicenter run --peer deviceName=<x> fuji.entries.list` dispatches to a peer
- [ ] WebSocket connects with subprotocol auth; access logs no longer contain `?token=`
- [ ] Token rotation via auth interceptor `onSuccess` doesn't get clobbered by `useSession.subscribe` refresh

---

## Coordination

This PR is one of three in the document-primitive rollout. Tracker: `specs/20260425T180002-orchestration-tracker.md`. PR-D and PR-E architecture: `specs/20260425T000000-device-actions-via-awareness.md`.
