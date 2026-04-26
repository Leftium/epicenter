# attachPeers — collapse the awareness/sync wiring boilerplate

**Date:** 2026-04-26
**Status:** Draft
**Author:** AI-assisted (Braden + Claude)
**Branch:** `post-pr-1705-cleanup`

## One-sentence thesis

Hide the `device + offers + standardAwarenessDefs + actionManifest` dance behind a single `attachPeers(doc, { device })` preset, so apps stop hand-wiring framework internals.

## Overview

Today, every app that wants peers does the same five-import, four-line dance to construct awareness with the right schema, derive the offers manifest from its own actions, and plumb the raw awareness into sync. The duplication isn't a copy-paste problem — it's a *layering* problem: derived state (`offers = actionManifest(actions)`) and framework conventions (`standardAwarenessDefs`) are leaking into application code. This spec adds `attachPeers`, a workspace-doc preset that owns those concerns, and migrates the four apps to it. As a follow-up, `peer()` consumes `attachPeers` directly and stops walking raw y-protocols states — killing the last `state.device?.id` site in the codebase.

**Breaking changes are fine.** No app has users yet.

## Motivation

### Current state

Every app does this:

```ts
const awareness = attachAwareness(
  doc.ydoc,
  { ...standardAwarenessDefs },                              // ← spread is cargo cult
  { device: { ...device, offers: actionManifest(doc.actions) } },  // ← derived state
);

const sync = attachSync(doc.ydoc, {
  url, getToken, waitFor: idb.whenLoaded,
  awareness: awareness.raw,                                  // ← manual marshalling
  actions: doc.actions,                                      // ← actions plumbed twice
});
```

Four problems:

1. **Derived state in app code.** `offers = actionManifest(doc.actions)` is a pure function of `doc.actions`. The framework can compute it; the app shouldn't have to know it exists.

2. **Framework conventions exposed.** `standardAwarenessDefs` is a public export only because apps need it to construct awareness. If `attachPeers` owns the schema, this export goes private.

3. **`actions` plumbed through two paths.** `attachSync` needs the live tree (for RPC dispatch); `attachAwareness` needs the derived manifest (for offer announcements). Same source, two paths, both threaded by hand.

4. **`resolvePeer` walks raw y-protocols states.** `packages/workspace/src/rpc/peer.ts:65` reads `awareness.getStates()` directly because there's no validated peer-list API at the right layer. The "between connect and first awareness frame" comment exists because the boundary is in the wrong place.

### Desired state

```ts
const doc   = openTabManagerDoc({ deviceId });
const idb   = attachIndexedDb(doc.ydoc);
attachBroadcastChannel(doc.ydoc);

const peers = attachPeers(doc, { device });                  // ← one line
const sync  = attachSync(doc.ydoc, {
  url, getToken,
  waitFor: idb.whenLoaded,
  awareness: peers.awareness.raw,
  actions: doc.actions,
});
```

Per-app deletion: 3 imports, 4 lines, all the spread/manifest noise. Same wire format. Same runtime behavior. Migration is mechanical.

## Design

### `attachPeers(doc, { device })`

Lives in `packages/workspace/src/document/attach-peers.ts`.

```ts
export function attachPeers<TDoc extends DocWithActions>(
  doc: TDoc,
  { device }: { device: DeviceDescriptor },
): Peers {
  const awareness = attachAwareness(
    doc.ydoc,
    standardAwarenessDefs,
    { device: { ...device, offers: actionManifest(doc.actions) } },
  );

  return {
    awareness,
    peers: () => awareness.peers(),
    findPeer: (deviceId: string) => /* validated walk over awareness.peers() */,
  };
}
```

Three responsibilities, all internal:

- Owns `standardAwarenessDefs` (un-exported from package root)
- Calls `actionManifest(doc.actions)` once at attach time
- Spreads `device` with `offers` — the framework's contract, not the app's

Surface:

- `peers.awareness` — exposed as escape hatch for `attachSync` wiring and for users who want to extend the awareness state for some reason
- `peers.peers()` — typed `Map<clientId, AwarenessState>` (every field guaranteed present, courtesy of the [synchronous publish invariant](#)).
- `peers.findPeer(deviceId)` — replaces the hand-rolled walk in `resolvePeer`.

### Package-level changes

```
packages/workspace/src/index.ts
  + export { attachPeers, type Peers, type DeviceDescriptor }
  - export { actionManifest }              // becomes private to attach-peers
  - export { standardAwarenessDefs }       // becomes private to attach-peers
  - export { type StandardAwarenessDefs }  // ditto
  (attachAwareness stays exported as the escape hatch)
```

### `peer()` proxy migration

```ts
// today
peer<Actions>(workspace: { awareness: { raw }, sync: { rpc } }, deviceId);

// after
peer<Actions>({ peers, sync }: { peers: Peers, sync: SyncAttachment }, deviceId);
```

`resolvePeer` becomes a one-liner over `peers.findPeer(deviceId)`. The "raw y-protocols guard" comment in `peer.ts` deletes itself because the source is now the validated wrapper.

## Why not future-proof for cursors / typing / other presence

This is the obvious objection: "If we add `attachPeers`, won't we also need `attachCursors`, and shouldn't the design accommodate both?"

**Answer: cursors don't go on this doc.**

```
WORKSPACE DOC  (fuji.ydoc, honeycrisp.ydoc, ...)     CONTENT DOC  (entryContentDocs[id].ydoc)
─────────────────────────────────────────────────    ─────────────────────────────────────────
What lives here:                                     What lives here:
- entries/notes table                                - the actual note text (Y.Text)
- which peers are online                             - WHO is editing right now
- what each peer offers (RPC manifest)               - WHERE their cursor is
                                                     - WHAT they have selected
                                                     
attachPeers preset goes here ✓                       future attachEditing preset goes here
```

Cursor positions are tied to the document being edited. When two people edit Note #42 together, their cursors are awareness state on `noteBodyDocs.get(42).ydoc`, not on `honeycrisp.ydoc`. This isn't speculation — it's how y-protocols + ProseMirror/CodeMirror integrations work everywhere.

So `attachPeers` and a future `attachEditing` would wrap *different awareness instances* on *different docs*. They never share state, never compete for schema slots, never need a plugin/composition mechanism.

**The escape hatch covers the 1% case.** If you genuinely need extra presence on a workspace doc (e.g., "X is viewing settings"), drop to `attachAwareness` directly:

```ts
const awareness = attachAwareness(doc.ydoc, {
  device: PeerDevice,
  viewing: ViewingSchema,
}, {
  device: { ...device, offers: actionManifest(doc.actions) },
  viewing: { route: '/' },
});
```

`attachPeers` is re-implementable in user-land using `attachAwareness`. That's the test for "is the layering right" — and it passes.

### Things explicitly NOT being built

- ❌ **Plugin system for awareness** (`attachAwareness(doc, [peersModule, cursorsModule])`). Schema merging + initial-value merging + namespace merging on the result, all for ONE field beyond device. Massive complexity tax for a hypothetical we may never collect.
- ❌ **`attachNetwork` mega-attachment** that owns idb + broadcastChannel + peers + sync. Loses orthogonality (Tauri apps that swap idb for sqlite can't reuse it; content docs can't reuse it). Two near-duplicate megafunctions instead of small composable pieces.
- ❌ **Builder pattern** (`doc.attach(idb()).attach(peers(...))`). Mutates the doc, order matters but isn't expressed in types, no win over straight-line code.
- ❌ **Extensible `attachPeers`** that accepts extra schema fields. If you need extension, drop to the primitive. Don't pre-design for cursors that aren't in any app yet.

## Plan

Four commits, executed in order. Each ships independently.

```
Commit 1  feat(workspace): add attachPeers(doc, { device })
          ├── new file packages/workspace/src/document/attach-peers.ts
          ├── owns standardAwarenessDefs internally (un-export it)
          ├── owns actionManifest internally (un-export it from package root)
          └── exposes { awareness, peers(), findPeer(id) }

Commit 2  refactor(apps): migrate 4 apps to attachPeers
          ├── -3 imports per app (attachAwareness, standardAwarenessDefs, actionManifest)
          ├── -4 lines per app
          └── still passes peers.awareness.raw to attachSync (no sync changes yet)

Commit 3  refactor(rpc): peer() consumes attachPeers; drop resolvePeer raw walk
          ├── peer<TActions>({ peers, sync }, deviceId)
          ├── resolvePeer → peers.findPeer (one line)
          ├── deletes "between connect and first awareness frame" comment
          └── kills the last state.device?.id in the codebase

Commit 4  (deferred — separate spec, optional)
          attach* take doc not doc.ydoc; sync infers awareness/actions from peers/doc
          High churn, large diff, only worth it if commits 1–3 don't feel clean enough.
```

Commits 1–3 are the core deliverable. Commit 4 is a follow-up if the consolidation feels worth it after seeing 1–3 land.

## Design decisions

**Decision: Name it `attachPeers`, not `attachPresence` / `attachDiscovery`.**

The vocabulary already exists everywhere — `peers()` on awareness, `findPeer`, `waitForPeer`, `peerSection`, `buildPeerRows`, `epicenter peers` CLI, the `peer()` proxy. Adding a new word for the same concept fragments the mental model.

**Decision: `attachPeers` takes `doc`, not `doc.ydoc`.**

It needs both `doc.ydoc` (to construct awareness) and `doc.actions` (to derive offers). Taking the bundle avoids a second parameter and matches what apps already have in scope. The constraint is `TDoc extends { ydoc: Y.Doc; actions: Actions }` — narrow, structural.

**Decision: `attachAwareness` stays exported.**

It's the documented escape hatch for any workspace doc that needs custom presence schema beyond `device`. Removing it would force apps into `attachPeers` even when the preset doesn't fit. Keep the primitive available; opinionated layers compose on top.

**Decision: `actionManifest` and `standardAwarenessDefs` go private.**

Once `attachPeers` is the way to publish a manifest, these have no remaining external consumers. Keeping them exported invites apps to bypass the preset and re-introduce the boilerplate. If a future use case needs them, re-export then.

**Decision: `attachSync` does not change in this spec.**

It still takes `awareness: peers.awareness.raw` and `actions: doc.actions` explicitly. Making sync pull awareness/actions from `peers`/`doc` is a separate, larger refactor (commit 4 above). Keep this spec's scope to "stop apps wiring framework internals" — sync's internals stay as-is.

**Decision: Keep `attach-*` flat under `document/`.**

No sub-folders (`document/presence/`, `document/storage/`). Six attachments total; the file list is readable in two seconds. The `attach-` verb prefix already namespaces them. Reorganization cost > readability gain.

## Migration impact

Per app (× 4):

```diff
- import {
-   actionManifest,
-   attachAwareness,
-   attachBroadcastChannel,
-   attachIndexedDb,
-   attachSync,
-   createDisposableCache,
-   type DeviceDescriptor,
-   standardAwarenessDefs,
-   toWsUrl,
- } from '@epicenter/workspace';
+ import {
+   attachBroadcastChannel,
+   attachIndexedDb,
+   attachPeers,
+   attachSync,
+   createDisposableCache,
+   type DeviceDescriptor,
+   toWsUrl,
+ } from '@epicenter/workspace';

- const awareness = attachAwareness(
-   doc.ydoc,
-   { ...standardAwarenessDefs },
-   { device: { ...device, offers: actionManifest(doc.actions) } },
- );
+ const peers = attachPeers(doc, { device });

  const sync = attachSync(doc.ydoc, {
    url, getToken, waitFor: idb.whenLoaded,
-   awareness: awareness.raw,
+   awareness: peers.awareness.raw,
    actions: doc.actions,
  });
```

In `peer()` (commit 3):

```diff
- const macbook = peer<Actions>(workspace, 'macbook-pro');
+ const macbook = peer<Actions>({ peers, sync }, 'macbook-pro');
```

CLI (`packages/cli/src/load-config.ts`) returns `peers` instead of `awareness`. Downstream call sites change from `workspace.awareness.peers()` to `workspace.peers.peers()` — naming reads slightly awkwardly but is consistent.

## Test plan

- `attachPeers` unit tests — schema is correct, initial state publishes synchronously, `findPeer` matches by deviceId.
- All existing awareness tests continue to pass (primitive unchanged).
- All existing CLI peers/list tests continue to pass (output identical).
- Smoke test in tab-manager: extension boots, awareness publishes device with offers, peers visible in `epicenter peers`.

## Open questions

1. Does `peers.peers()` read awkwardly enough to warrant a rename? Options: `peers.list()`, `peers.all()`, `peers.connected()`. Defer until commit 2 lands and we read the call sites.
2. Should `findPeer` return `Result<Peer, PeerNotFound>` for consistency with the rest of the API? Or stay `Peer | undefined` since it's a synchronous lookup? Lean toward Result.
