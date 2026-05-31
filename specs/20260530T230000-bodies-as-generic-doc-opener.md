# Bodies as app-owned doc caches (delete the body subsystem, invert control)

**Date**: 2026-05-30
**Status**: IMPLEMENTED. The asymmetric
move: delete the schema-derived body subsystem and replace it with a single app-owned
`createDisposableCache` keyed by the app's own id, where the build closure derives the
guid, attaches the shared type, and wires the updatedAt bump. No new library primitive.
Grounded against the repo, the git history of every prior doc-opener shape, and the
convergent prior art (automerge-repo `repo.find(url)`, Jazz `LocalNode.load(id)`) via
DeepWiki.
**Owner**: Workspace platform

## Relationship to prior specs

```txt
SUPERSEDES (mechanism)  20260530T180000-schema-declared-body-docs.md
                        Deletes column.body, the BodyMarker partition, bodyDocGuids
                        derivation, attachBodyCache, the generic schema-enumerating
                        daemon. Keeps the deterministic docGuid scheme (parity) and the
                        Yjs grounding (a live shared type cannot live in an encrypted row).

SUPERSEDES (mechanism)  20260530T220000-body-docs-clean-break.md  (Part 1 only)
                        That spec polished the body subsystem (delete codec, online(),
                        fold touch) but KEPT it. This deletes the subsystem instead.
                        Part 2 (the encryption gradation) STILL HOLDS, restated below.

RESTORES (the thesis)   20260420T230100-collapse-document-framework.md
                        "Apps own content-doc construction directly; the framework must
                        not own Y.Doc construction or force a registry." This spec returns
                        to that exact shape: buildEntryContentDoc as a createDisposableCache
                        builder, app-owned, keyed by the app's id.
```

## One sentence

A "body" is not a kind of column the framework must understand; it is just another
`Y.Doc`, so each app builds its OWN typed cache (`createDisposableCache` keyed by the
app's id) whose build closure derives the guid, attaches whatever shared type it wants,
and wires any side effects, which deletes the entire body subsystem (`column.body`, the
codec, the derivation, the generic body cache, the schema-enumerating daemon) with no new
library primitive at all.

---

## The reframe (why every prior shape optimized the wrong axis)

Every iteration asked: "how does the framework KNOW a field is a body and read it FOR me
with zero caller knowledge?" That question forces schema declaration, a partition, a
derivation, a reader/codec, and a generic daemon. The git history is six shapes of
answering it (createContentDocStore -> .withDocument -> client.documents -> defineDocument
-> the refused workspace.docs registry -> column.body), each heavier than the last for the
same one feature.

The inversion asks the opposite: "what is the SMALLEST thing the framework owes, and can
the APP own the rest?" The answer turns out to be: the framework owes NOTHING new. The app
already has `createDisposableCache`. A body is just:

```txt
createDisposableCache((id) => buildEntryContentDoc(id))
  where buildEntryContentDoc derives the guid, attaches rich text, wires the touch.
```

This is the convergent prior art at the right altitude: automerge-repo `repo.find(url)`
and Jazz `LocalNode.load(id)` are "address by id, cache by id, caller owns the type." We
do the same, except the id is the app's typed row id (not an opaque url), the guid is
DERIVED from it (decision D2), and the cache is app-owned and typed (not a global
registry). Verified convergent, not a guess.

The cost we accept (the refused 10 percent): the daemon is no longer a generic binary that
materializes ANY app's bodies from schema with zero app code. Each app writes a ~12-line
materialize loop. At 1 to 3 apps this is trivial; the generic daemon was speculative
generality for a multi-app product that does not exist yet. When it does, an app-owned
cache is still its substrate; schema-derivation can return as a thin layer ON TOP.

---

## The layers (there are only three, and two already exist)

```txt
ISO (already exists)   entryContentDocGuid(id) = docGuid(FUJI_ID,'entries',id,'content')
                       attachRichText(ydoc) -> { binding, read }
                       The row->doc link + the shared type. Shared by browser AND daemon.
                       Nothing new; both live in the repo today.

BROWSER (the cache)    const entryBodies = createDisposableCache((id: EntryId) => {...})
                       Built INSIDE openFujiBrowser, closing over signedIn + tables.
                       Keyed by EntryId. Exposed on the bundle as `fuji.entryBodies`.
                       This is the ONLY place "a Fuji entry body" is defined.

DAEMON (no cache)      a loop: for each entry, build a Y.Doc, attach yjs-log + sync, read,
                       destroy. The daemon never opens the same guid twice concurrently,
                       so it needs NO cache (two honest lifecycles, per 180000 decision G).
```

```txt
YJS DOC GRAPH (unchanged: every doc a separate top-level guid-addressed Y.Doc)

  ROOT  guid="epicenter-fuji"   EncryptedYkvLww tables.entries (row VALUES = ciphertext)
        row k7x9 = { id, title, updatedAt, ... }   <- NO body column anymore
              |
              |  entryContentDocGuid(k7x9)  (pure fn, identical to today: NO data move)
              v
  BODY  guid="epicenter-fuji.entries.k7x9.content"   getXmlFragment('content') via attachRichText
        opened on demand by entryBodies.open(k7x9); plaintext-in-doc, enc at-rest IDB only
```

---

## Why a cache at all (the one piece worth defending)

A cache means "same id -> same Y.Doc." Drop it and two surfaces opening the same entry
(the editor + a markdown export triggered while editing, or a future split-pane preview)
each `new Y.Doc({sameGuid})`:

```txt
two Y.Docs, same guid, one tab:
  IDB    per-guid, but does NOT live-push one doc's writes into the other doc in-tab
  relay  reconciles them, but only when ONLINE, via a round-trip
  offline -> they DIVERGE until reconnect
```

That is a correctness footgun, not just waste. `createDisposableCache` makes it impossible
for one cent (refcount + grace window). This is exactly why automerge-repo and Jazz cache
by id. The BROWSER needs it (concurrent surfaces); the DAEMON does not (one guid at a
time). So "do we track documents?" -> browser yes, daemon no.

---

## What deletes / what adds

```txt
DELETE (library)
  packages/workspace/src/document/column/body.ts          BODY marker, body(), isBodyMarker
  packages/workspace/src/document/body-codec.ts           BodyCodec, richText()
  packages/workspace/src/document/body-doc-set.ts         bodyGuid, bodyDocGuids, BodyRoom
  packages/workspace/src/document/attach-body-cache.ts    attachBodyCache + the pending-map hack
  packages/workspace/src/daemon/sweep-bodies.ts           the one-shot generic sweep
  + their tests (body-doc-set.test.ts x2, sweep-bodies.test.ts)

SHRINK (library)
  packages/workspace/src/document/table.ts                remove ColumnLike, BodyMarker import,
                                                          DataColumns body-partition, partitionColumns,
                                                          BodyField. VersionedColumns -> Record<string,TSchema>;
                                                          RowOf -> plain; createReadonlyTable drops the
                                                          partition call in versionSchemas.
  packages/workspace/src/document/define-table.ts         drop the BodyMarker branch in ConstrainColumns
  packages/workspace/src/document/column/sugar.ts         remove `body` from the column namespace
  packages/workspace/src/index.ts                         barrel: drop richText, attachBodyCache,
                                                          body-doc-set, BodyCodec exports

ADD (library)
  NOTHING. createDisposableCache already exists and is the whole substrate.

ADD / EDIT (fuji)
  apps/fuji/src/lib/workspace/index.ts                    DELETE `content: column.body(richText())`.
                                                          KEEP entryContentDocGuid (unchanged).
  apps/fuji/src/lib/workspace/browser.ts                  const entryBodies = createDisposableCache(
                                                          (id) => buildEntryContentDoc(id)); expose it.
                                                          Delete attachBodyCache usage. (Optional: a local
                                                          `wire(ydoc, actions)` helper so root + body share
                                                          the attachLocalStorage+openCollaboration pair.)
  apps/fuji/src/routes/(signed-in)/components/EntryBodyEditor.svelte
                                                          fuji.bodies.body('entries', id) -> fuji.entryBodies.open(id)
  apps/fuji/src/lib/workspace/markdown.ts                 read body via fuji.entryBodies.open(id).read()
  apps/fuji/src/lib/workspace/project.ts (daemon)         a ~12-line loop, no cache

NET: 5 files + 3 tests deleted, ~500+ LOC removed; ZERO new library primitives; ONE
     ~15-line build closure added in fuji's browser composition. Tables return to plain
     Record<string,TSchema>.
```

---

## Before / after call sites

### Schema (apps/fuji/.../index.ts)

```ts
// BEFORE (v3 columns record)
content: column.body(richText()),
// AFTER
// (deleted. entries are plain metadata. The row->doc link is entryContentDocGuid(id),
//  already present below and unchanged. column.body was always partitioned OUT of the
//  stored row, so deleting it changes ZERO stored bytes and needs no migration.)
```

### Browser composition (apps/fuji/.../browser.ts)

```ts
// AFTER. Built inside openFujiBrowser, closing over signedIn + workspace.tables.
// Optional local DRY helper so the ROOT doc and the body builder share the pair:
const wire = (ydoc: Y.Doc, actions: Actions = {}) => {
  const idb  = attachLocalStorage(ydoc, { server: signedIn.server, ownerId: signedIn.ownerId, keyring: signedIn.keyring });
  const sync = openCollaboration(ydoc, {
    url: roomWsUrl({ baseURL: signedIn.baseURL, ownerId: signedIn.ownerId, guid: ydoc.guid, deviceId }),
    openWebSocket: signedIn.openWebSocket, onReconnectSignal: signedIn.onReconnectSignal,
    waitFor: idb.whenLoaded, actions,
  });
  return { idb, sync };
};

const { idb, sync: collaboration } = wire(workspace.ydoc, workspace.actions);   // root: opened once

// The ONE place "a Fuji entry body" is defined. Typed to EntryId. Browser-only.
const entryBodies = createDisposableCache((id: EntryId) => {
  const ydoc = new Y.Doc({ guid: entryContentDocGuid(id), gc: true });   // derive the guid INSIDE
  const { idb: bodyIdb, sync: bodySync } = wire(ydoc);                    // actions: {} for bodies
  const text = attachRichText(ydoc);                                      // caller picks the shared type
  const off  = onLocalUpdate(ydoc, () =>                                  // the touch, in app code
    workspace.tables.entries.update(id, { updatedAt: DateTimeString.now() }));
  return {
    ydoc, binding: text.binding, read: text.read, whenLoaded: bodyIdb.whenLoaded,
    [Symbol.dispose]() { off(); bodyIdb /* disposed via ydoc.destroy chain */; ydoc.destroy(); },
  };
});

// expose on the bundle:  return defineWorkspace({ ...workspace, idb, collaboration, entryBodies, ... })
```

### Editor (EntryBodyEditor.svelte)

```ts
// BEFORE
const contentDoc = fuji.bodies.body('entries', entryId);
$effect(() => () => contentDoc[Symbol.dispose]());
// ySyncPlugin(contentDoc.binding); await contentDoc.idb.whenLoaded;

// AFTER (still never imports the table; the touch lives in the builder, not here)
const body = fuji.entryBodies.open(entryId);
$effect(() => () => body[Symbol.dispose]());
// ySyncPlugin(body.binding); await body.whenLoaded;
```

### Markdown export (apps/fuji/.../markdown.ts)

```ts
// BEFORE: const contentDoc = host.bodies.body('entries', entry.id); await contentDoc.idb.whenLoaded; contentDoc.read()
// AFTER
using body = host.entryBodies.open(entry.id);
await body.whenLoaded;
const text = body.read();
```

### Daemon (apps/fuji/.../project.ts) — no cache, a plain loop

```ts
for (const entry of tables.entries.getAllValid()) {
  const ydoc = new Y.Doc({ guid: entryContentDocGuid(entry.id), gc: true });
  const infra = attachProjectInfrastructure(ydoc, { /* yjs-log + sync, actions: {} */ });
  await infra.collaboration.whenConnected;                       // NOT a non-existent firstSync
  markdown.writeBody('entries', entry.id, attachRichText(ydoc).read());
  ydoc.destroy();
}
// Steady-state body observer (re-materialize on the body's own update stream) is the SAME
// Phase 3 work the 180000 spec scoped; unchanged, just app-owned, still no cache.
```

---

## Design decisions

### D1. An app-owned, typed cache keyed by the app's id (NOT a generic guid opener)

```txt
Decision:
  Each app builds its own createDisposableCache keyed by its row id type (EntryId for
  fuji). The build closure derives the guid, attaches the shared type, wires side effects.
  No generic docs.open(guid). No library createDocs wrapper.

Why:
  - Typed in, typed out: entryBodies.open(entryId) -> a fuji body handle. A raw
    docs.open(guid) is stringly-typed, has no row link, and invites opening arbitrary
    docs with no known type, the column.doc() footgun 180000 decision C refused.
  - createDisposableCache already IS the substrate (open/refcount/grace/dispose). A
    createDocs(open) wrapper saved ~5 lines and added a generic layer for no capability.
  - It is the convergent prior art at the right altitude (repo.find/LocalNode.load cache
    by id), specialized to a typed id with a derived guid.

Refused:
  - A library createDocs(open) primitive. Mentally inlined, it is createDisposableCache
    plus the ydoc-nesting boilerplate; the boilerplate is 3 lines and reads fine inline.
  - A generic top-level docs.open(guid). Untyped, link-less, footgun. If a second doc
    KIND appears (attachments), make a SECOND typed cache, honestly separate.
```

### D2. Derive the guid; do NOT store a url column (escape hatch named)

```txt
Decision:
  The row->doc link is entryContentDocGuid(id) = docGuid(FUJI_ID,'entries',id,'content'),
  unchanged from today. Nothing is stored on the row. No body column of any kind.

Why:
  - Total function: every row has an openable guid with no write step, so no "bodyless
    row" failure mode (the bug a stored id introduces if a create site forgets it).
  - Parity: entryContentDocGuid is byte-identical to today's storage; existing bodies are
    found at their current rooms with NO data move.
  - For fuji, content belongs to exactly one entry forever; the row id is an immutable
    nanoid, so the derived guid is as stable as the row. Nothing to decouple.

Refused (named as the escape hatch):
  - Storing a url/id column (the automerge-repo / Jazz reference model). Right ONLY when a
    doc must be decoupled from its row (re-parented, shared, kept after hard-delete). No
    app needs this today. Reversible: the cache key and builder change, nothing else.
```

### D3. Use the existing createDisposableCache directly (ship no new primitive)

```txt
Decision:
  The body cache is a direct createDisposableCache call in the app's browser composition.
  No createDocs, no online(), no attachBodyCache.

Why:
  - The whole point of the inversion is that the framework owes nothing new. Every layer
    added (createDocs/online/attachBodyCache) is mentally-inlinable into a
    createDisposableCache call with an app-specific build closure.
  - The build closure (derive guid, wire storage+sync, attach rich text, wire touch,
    compose dispose) is ~12 lines of honest app composition that reads top to bottom. It
    is the buildEntryContentDoc the collapse spec (20260420) already designed and liked.

Refused:
  - A shared `online`/`wire` LIBRARY helper. A LOCAL wire(ydoc, actions) inside browser.ts
    (so root + body do not copy-paste the attachLocalStorage+openCollaboration pair) is
    optional and fine, but it is a 5-line local DRY helper, not a library concept or a
    named lifecycle. Do not export it.
```

### D4. The cache is BROWSER-ONLY; the daemon does not track

```txt
Decision:
  createDisposableCache lives in openFujiBrowser (needs signedIn). The daemon does NOT use
  it: it loops, building one Y.Doc at a time, reading, destroying.

Why:
  - The cache exists for idempotency under CONCURRENT surfaces (editor + export/preview),
    which only the browser has. The daemon processes one guid at a time, so a cache would
    only ever hold one entry; it is pure overhead there.
  - Two honest lifecycles (180000 decision G): browser holds bodies live while the UI
    references them; the daemon must NOT hold every body live (a large vault would exhaust
    memory). The asymmetry is expressed by browser-has-a-cache / daemon-loops, not a flag.
```

### D5. The touch lives in the build closure, not the editor and not the library

```txt
Decision:
  onLocalUpdate(ydoc, () => tables.entries.update(id, { updatedAt: now() })) lives in the
  build closure (which closes over tables). The editor calls open() and never references
  the table. The daemon's loop simply never wires it (it must not write rows).

Why:
  - onLocalUpdate's tx.local filter already prevents IDB hydration / remote sync from
    bumping; only a real local edit does.
  - Keeping it in the builder (not the editor) keeps the editor decoupled from the schema
    (180000 decision D) AND keeps it out of the library (there is no library). The
    browser/daemon asymmetry is which composition wires it.
```

### D6. The handle shape

```txt
Decision:
  open(id) returns { ydoc, binding, read, whenLoaded, [Symbol.dispose] }. `binding` for
  ySyncPlugin, `read` for export/materialize, `whenLoaded` to gate UI, `ydoc` as the
  escape hatch, dispose decrements the refcount (createDisposableCache grace handles
  teardown).

Why:
  - Exactly what the three consumers need (editor, export, daemon-read), nothing more.
  - ydoc is exposed but documented as the escape hatch; routine code uses binding/read.
```

### D7. Pass attachRichText directly; delete the richText() codec wrapper

```txt
Decision:
  The build closure calls attachRichText(ydoc) directly. BodyCodec + richText() deleted.

Why:
  - attachRichText(ydoc) -> { binding, read } is already the primitive. The codec was a
    single-method object around it; "codec" was the wrong word (it binds a shared type and
    reads it, it does not encode/decode bytes). With the builder owning the type, nothing
    is left to wrap.

Refused:
  - A content-type factory survives ONLY when a type takes OPTIONS (attachTimeline(...),
    attachRichText({ placeholder })). Even then the builder calls it directly; no universal
    codec type.
```

---

## Parity invariant (prove first; the only data-safety item)

```txt
entryContentDocGuid(id) is UNCHANGED, so every existing body is found at its current room.
Cheapest decisive check (no cloud, no fs):
  assert entryContentDocGuid(someId) === docGuid({workspaceId:FUJI_ID, collection:'entries',
                                                  rowId:someId, field:'content'})
This is already true (it IS that call). Deleting column.body changes ZERO stored bytes
because column.body was always partitioned out of the stored row. No migration, no move.
```

---

## Encryption gradation (carried over from 220260530T220000 Part 2, UNCHANGED)

This spec changes the doc-opener mechanism only. The encryption posture still governs:

```txt
- The keyring is SERVER-derived (ENCRYPTION_SECRETS + ownerId, re-fetched at /api/session),
  NOT user-held. So there is NO consumer key-loss risk, and it is NOT zero-knowledge (the
  operator can re-derive the key).
- Decision: stay Path A (host-trusted encryption at rest, recoverable, full-featured).
  Self-host is the privacy answer (same third-party privacy as zero-knowledge, fails
  gracefully). Bodies stay encrypted at rest (per-guid IDB). Do NOT build wire-sealing now
  (with a server-derived key it would not hide bodies from the operator, only a passive
  relay leak). Keep zero-knowledge POSSIBLE; do not build it.
- Body docs opened by the cache thread the keyring EXACTLY as the root does
  (attachLocalStorage derives the per-guid at-rest key off ydoc.guid). The cache is
  agnostic to this: the build closure just calls attachLocalStorage, which already threads
  the keyring.
```

---

## What we lose / what we gain

```txt
LOSE
- No compile-time "this field is a body" hint; it becomes a convention (entryContentDocGuid
  + the entryBodies cache, both next to the table, named + documented: one hop to find).
- The daemon is not generic across apps; each app wires ~12 lines of materialization.
- The 3 small per-app guid functions 180000 wanted to delete stay (3 lines each), local
  and honest, far cheaper than the subsystem that replaced them.

GAIN
- 5 files + 3 tests deleted, ~500+ LOC removed; ZERO new library primitives.
- Tables return to plain Record<string,TSchema>: no ColumnLike, DataColumns, partition,
  pending-map hack.
- The one place a body lives is one ~15-line closure you can point at.
- Adding a second doc kind (attachments) is another typed cache, not a generic bag.
```

---

## Phased plan (build, prove, remove)

```txt
Phase 1  Fuji browser: add the entryBodies = createDisposableCache(...) closure (+ optional
         local wire helper); expose `entryBodies` on the bundle. Repoint EntryBodyEditor +
         markdown to fuji.entryBodies.open(id). Delete the attachBodyCache usage.
         Prove: editor binds, edits persist + sync, updatedAt bumps, route-swap reuses.
         (column.body still present but unused at this point.)

Phase 2  Fuji daemon: the ~12-line materialize loop (no cache). Delete the sweep-bodies
         usage. Prove: daemon writes the entry .md body.

Phase 3  Stop importing the body subsystem everywhere (now unused on disk). Typecheck +
         tests green. This is the rollback point.

Phase 4  DELETE: column/body.ts, body-codec.ts, body-doc-set.ts, attach-body-cache.ts,
         daemon/sweep-bodies.ts + their tests. SHRINK table.ts/define-table.ts/sugar.ts
         back to plain columns. Remove the deleted barrel exports. Delete the
         `content: column.body(...)` schema line. Grep zero: column.body, attachBodyCache,
         BodyMarker, bodyDocGuids, richText(, BodyCodec, partitionColumns, ColumnLike.

Phase 5  Verify: bun test (workspace + fuji), bun run build, bun run typecheck (fuji).
         Manual smoke: create entry, type body, reload (persist), two tabs (sync), daemon
         up (.md has body). Parity assert from above.
```

## Risks

```txt
- Blast radius is the schema layer (table.ts/define-table.ts partition removal). Do it LAST
  (Phase 4), after the new path is proven, so a revert point exists.
- createDisposableCache requires the cached value be a plain object (it spreads to build the
  handle), NOT a bare Y.Doc. The build closure returns { ydoc, ... }; never return the raw
  Y.Doc.
- Daemon connect wait: use collaboration.whenConnected, NOT a non-existent firstSync (the
  yjs-log has no whenLoaded). Add a per-doc connect timeout so one stalled room cannot back
  up the loop.
- Body confidentiality is unchanged (plaintext to the relay + daemon log today). See the
  encryption gradation; decide consciously, do not discover.
- Multi-body-per-table / multi-table bodies: add another typed cache + guid helper. No
  library change; that is the point.
```

## References

```txt
packages/workspace/src/cache/disposable-cache.ts          the substrate (open/refcount/grace/dispose)
packages/workspace/src/document/doc-guid.ts               docGuid scheme (parity)
apps/fuji/src/lib/workspace/index.ts                      entryContentDocGuid (kept), schema line to delete
apps/fuji/src/lib/workspace/browser.ts                    where entryBodies is built; attachBodyCache to delete
apps/fuji/src/routes/(signed-in)/components/EntryBodyEditor.svelte   the editor call site
apps/fuji/src/lib/workspace/markdown.ts                   body read for markdown
packages/workspace/src/document/attach-rich-text.ts       attachRichText -> { binding, read } (the real primitive)
packages/workspace/src/document/on-local-update.ts        tx.local filter for the touch
specs/20260530T180000-schema-declared-body-docs.md        the subsystem this supersedes (keep its Yjs grounding)
specs/20260530T220000-body-docs-clean-break.md            Part 2 encryption gradation still holds
specs/20260420T230100-collapse-document-framework.md      the "apps own construction" thesis this restores
automerge/automerge-repo, garden-co/jazz (DeepWiki)       repo.find(url) / LocalNode.load(id): convergent prior art
```

## Review

**Completed**: 2026-05-31
**Branch**: body-docs-app-owned-cache

### What Landed

Fuji now owns entry body construction in `openFujiBrowser()`. The browser exposes
`fuji.entryBodies.open(entryId)`, and the builder derives the existing
`entryContentDocGuid(id)`, attaches rich text, wires local storage and sync, and bumps
`updatedAt` on local body edits.

The daemon path no longer uses the deleted sweep helper. It opens one derived entry body
doc at a time, attaches project infrastructure, waits on `collaboration.whenConnected`
with a timeout, reads `attachRichText(ydoc).read()`, destroys the doc, and feeds the text
into the markdown materializer's `toMarkdown` hook.

### Deviations and Discoveries

- The spec's `markdown.writeBody(...)` pseudocode was not a real API. Fuji writes body
  text through the existing markdown materializer shape: `toMarkdown(row)` returns
  `{ frontmatter, body }`.
- The deleted subsystem files were already untracked in the worktree when implementation
  started. They were removed from disk, but they do not appear as tracked deletions in
  `git diff --stat`.

### Verification

- `bun run --filter @epicenter/workspace typecheck`
- `bun run --filter @epicenter/fuji typecheck`
- `bun run --filter @epicenter/workspace test`
- `bun run --filter @epicenter/fuji test`
- `bun run --filter @epicenter/fuji build`
- Required grep-zero sweep across `apps` and `packages`
- Parity assertion: `entryContentDocGuid(id) === docGuid({ workspaceId: FUJI_ID, collection: 'entries', rowId: id, field: 'content' })`

Root `bun run build` was also run and failed in unrelated `opensidian#build` code at
`apps/opensidian/src/lib/state/skill-state.svelte.ts:145`.
