# Document Sync and Identity Collapse

**Date**: 2026-05-13
**Status**: Draft (v2, hard break)
**Author**: AI-assisted (Claude + Braden design session)
**Branch**: TBD

## Overview

Collapse `@epicenter/workspace` to a single document primitive (`openCollaboration`), and put the identity trust boundary at the wire envelope: server stamps `subject` on an outer frame, client-claimed `replica` lives inside the Yjs awareness payload, and consumers read both via the peers surface. Hard break: no transitional shims, no deprecation re-exports.

## Motivation

### Current State

Two parallel document primitives wrap one supervisor:

```ts
// packages/workspace/src/document/open-collaboration.ts
openCollaboration(ydoc, { identity, actions, url, ... }): Collaboration

// packages/workspace/src/document/attach-yjs-sync.ts
attachYjsSync(ydoc, { url, ... }): YjsSyncAttachment   // hides 2 RPC methods
```

`attachYjsSync` composes nothing new. It forwards five lifecycle members and hides `sendActionRequest` / `sendRuntimeRequest`. The "two shapes" are one shape with a misleading second name.

The supervisor is bimodal via nullable config:

```ts
// packages/workspace/src/document/internal/sync-supervisor.ts:141-167
SyncSupervisorConfig = {
  awareness?: Awareness;                // null = byte-transport mode
  onActionRequest?: (...);               // null = ActionNotFound fallback
  onRuntimeRequest?: (...);              // null = ActionNotFound fallback
};
```

Null-checks scatter through every awareness handler and every RPC dispatch (`sync-supervisor.ts` lines 344, 373, 384, 388, 398, 408, 562).

Identity is a flat client-claimed blob:

```ts
// packages/workspace/src/document/peer-identity.ts:25-29
PeerIdentity = type({
  id: 'string',           // (user, device) conflated
  name: 'string',         // display, stale snapshot, lives in awareness
  platform: '"web" | "tauri" | "chrome-extension" | "node"',
});
```

The server treats awareness frames as opaque bytes. Clients claim their own identity, even though the server already authoritatively knows the connected user from the OAuth bearer.

Apps thread a `peer: PeerIdentity` through workspace constructors. Content docs use `attachYjsSync`, no identity at all.

### Problems

1. **Trust boundary is wrong.** Client claims its own identity. Server has the authoritative knowledge but doesn't use it. Same field can be impersonated by any client.
2. **Identity field conflates three lifetimes.** Subject (forever), replica (per install), display (changes mid-session) all in one blob, all republished together. Future cursors or status will collide.
3. **Two document primitives, one implementation.** `attachYjsSync` adds no behavior, no surface. Wrapper is symptom; dual API is disease.
4. **Supervisor bimodal by null-check.** Reading the file requires holding "is this configured?" in mind at every awareness handler.
5. **Display name is a stale snapshot.** Rename never propagates because `name` is captured at workspace construction.

### Desired State

```ts
// Schema (awareness payload) — purely client-claimed
peerAwarenessSchema = {
  replica: type({ id: 'string', platform: '"web"|"tauri"|"chrome-extension"|"node"' }),
  actionPaths: type('string[]'),
};

// Wire envelope (new frame kind) — server-stamped
{
  kind: 'awareness-attested',
  subject: string,             // server-derived from auth session
  payload: <opaque y-protocols awareness bytes>
}

// Consumer surface — joins envelope + payload by clientID
type Peer = {
  clientID: number;             // Yjs, per session
  subject: string;              // from envelope, server-trusted
  replica: { id, platform };    // from payload, client-claimed
  actionPaths: readonly string[];
};

// One document primitive; one workspace input
openCollaboration(ydoc, { url, replica, actions: {} });
openFujiBrowser({ replica, encryptionKeys, openWebSocket });
```

The server is the identity authority. The client publishes only what only the client knows. Display data lives outside this refactor.

## Research Findings

### Two-lens identity brainstorm

Two parallel brainstorm passes (structural decomposition + authority/trust) converged on the same tiered shape: subject (server-trusted, forever) + replica (client-claimed, per install) + display (lookup, mid-session mutable).

| Lens | Top pick | Convergence |
| --- | --- | --- |
| Structural (lifetime decomposition) | Orthogonal facets by lifetime | Subject / Replica / Presence as independent keys |
| Authority/trust | Tiered with trust boundary | Subject server-stamped, replica client-claimed, display looked up |

**Key finding**: lifetime decomposition and authority decomposition produce the same shape. The Yjs awareness schema is field-keyed and validated per-key, which makes the split structurally cheap.

**Implication**: the right shape is unambiguous. The remaining design space is *where* server-stamped subject lives (inside the awareness payload or on an outer envelope) and *how* it gets stamped.

### Envelope vs payload-rewrite

Investigation: how does the server stamp `subject` while preserving Yjs payload opacity?

| Mechanism | Server parses Yjs payload | Wire format change | Trust boundary visible at type level |
| --- | --- | --- | --- |
| Outer envelope | No | New frame kind | Yes (envelope vs payload) |
| Payload rewrite | Yes (must parse + re-encode awareness) | No (existing AWARENESS frame) | No (one field in one schema) |

**Key finding**: envelope is strictly cleaner. Server stays oblivious to y-protocols; the trust boundary is a wire-frame property, not a field convention.

**Implication**: envelope wins on every architectural axis. Cost is a new `MESSAGE_TYPE` in `@epicenter/sync`. Verify whether existing types can carry a stamped subject as a wrapper or whether a new kind is needed.

### Document primitive duality

Investigation: what does `attachYjsSync` add vs `openCollaboration`?

| Primitive | Supervisor config | Returns | Composes new surface |
| --- | --- | --- | --- |
| `openCollaboration` | awareness + RPC handlers | `Collaboration` | Yes: peers, identity, actions, `[Symbol.dispose]` |
| `attachYjsSync` | nothing extra | `YjsSyncAttachment` | No: forwards 5 lifecycle members |

**Key finding**: `attachYjsSync` is 14 lines of pure type narrowing. The wrapper exists only to hide RPC methods.

**Implication**: deleting `attachYjsSync` removes a file and a type but no behavior. Content docs become callers of `openCollaboration` with `actions: {}`.

### Cache pattern

Investigation: does `createDisposableCache` earn its keep?

**Key finding**: six concrete UI patterns break without it (multi-component observers on same body, fast back-nav, optimistic write upload past dispose, split views, reactive queries that read body data, HMR survival).

**Implication**: cache stays unchanged. What changes is what goes inside the build closure: `openCollaboration` instead of `attachYjsSync`.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Awareness payload contents | 2 coherence | Purely client-claimed: `replica` + `actionPaths` | Schema represents claims; trust-attested data lives on the envelope, not in the payload |
| Server-stamp location | 2 coherence | Outer envelope frame, server-attested | Yjs payload stays opaque; trust boundary visible at the wire frame |
| `subject` shape | 3 taste | `subject: string` (flat, not nested) | YAGNI: nest when a second field exists, not before |
| `replica` shape | 2 coherence | `replica: { id, platform }` | `id` is install-stable, `platform` is install-property; same cohesion |
| Drop `name` from identity | 2 coherence | Display data lives in a separate lookup (deferred to its own spec) | Display is mid-session mutable; identity is stable; conflating them breaks rename UX |
| Delete `attachYjsSync` | 2 coherence | Content docs use `openCollaboration` with `actions: {}` | Wrapper composes nothing; one primitive collapses two surfaces |
| `actions` default `{}` | 2 coherence | Optional with default | Content docs and consume-only peers don't need to pass an empty object |
| Supervisor nullable handlers become required | 2 coherence | `awareness`, `onActionRequest`, `onRuntimeRequest` required | Follows from killing `attachYjsSync`; deletes scattered null-checks |
| `actionPaths` stays top-level (not nested under `replica`) | 2 coherence | Top-level key | Consumed independently by peers surface; nesting adds an irrelevant dependency |
| `presence` key in this spec | 2 coherence | Not added | Schema is per-key validated; adding a field later is one line, not a migration |
| Workspace input contract | 2 coherence | `replica: { id, platform }`; subject comes from auth session | Client supplies only what only the client knows |
| Hard break (no transitional shims) | 3 taste | No deprecated re-exports; v1 types delete with v1 code | Pre-1.0; churn of transitional aliases costs more than rip-and-replace |
| `replica.id` generation strategy | 3 taste | Workspace package exports a small helper `createReplicaId({ storage })`; apps call it | One implementation, all apps use it; storage primitive passed as config |
| Server stamping wire format | Deferred | See Open Questions | Two viable sub-shapes within "envelope"; requires server reviewer |
| Anonymous link-share content docs | Deferred | Not in scope | Future case; subject-optional + per-link identity is a separate refactor |
| Display name lookup endpoint | Deferred | Not in scope | Lands in a separate spec when avatars/colors/rename UX become real |

## Architecture

### Wire layers, before and after

```
BEFORE
──────
Client publishes:                          Server relays:
y-protocols AWARENESS frame                opaque bytes (no parse, no stamp)
└─ { identity: { id, name, platform },
     actionPaths: [...] }


AFTER
─────
Client publishes:                          Server attests on ingress:
y-protocols AWARENESS frame (payload)      wraps in new envelope frame
└─ { replica: { id, platform },            ├─ subject: <auth-derived>
     actionPaths: [...] }                  └─ payload: <unchanged bytes>
                                           relays the envelope to peers

Peers receive:                             Consumer surface joins:
envelope { subject, payload }              { clientID, subject,
                                             replica, actionPaths }
```

### Trust boundary, type-level

```
┌────────────────────────────────────────────────────────────────┐
│ Awareness payload  (peerAwarenessSchema)   CLIENT-CLAIMED ONLY │
│  ├─ replica:    { id, platform }                                │
│  └─ actionPaths: string[]                                       │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ Wire envelope frame                         SERVER-ATTESTED    │
│  ├─ subject: string         (from auth session)                 │
│  └─ payload: <opaque y-protocols awareness bytes>               │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ Peer (consumer surface)         JOINED at the supervisor       │
│  ├─ clientID:    number     (Yjs, per-session)                  │
│  ├─ subject:     string     (from envelope, server-trusted)     │
│  ├─ replica:     { id, platform } (from payload)                │
│  └─ actionPaths: readonly string[]                              │
└────────────────────────────────────────────────────────────────┘
```

### Document primitive collapse

```
BEFORE                              AFTER
──────                              ─────
openCollaboration ────┐             openCollaboration
                      ├─► supervisor   (one entry point, full surface;
attachYjsSync ────────┘    (bimodal:    actions defaults to {})
                            null         │
                            handlers)    ▼
                                       createSyncSupervisor
                                       (internal; all config required)
```

### Workspace constructor

```
openFujiBrowser({ replica, encryptionKeys, openWebSocket })
     │
     ├── rootYdoc → openCollaboration({
     │        url: /workspaces/<rootGuid>,
     │        replica,                     ◄── passed by reference
     │        actions: rootActions,
     │   })
     │
     └── entryContentDocs = createDisposableCache((entryId) => {
              const childYdoc = new Y.Doc({ guid: entryContentDocGuid(...) })
              attachIndexedDb(childYdoc, ...)
              attachOwnedBroadcastChannel(childYdoc, ...)
              return openCollaboration(childYdoc, {
                  url: /documents/<childGuid>,
                  replica,                  ◄── same reference
                  // actions omitted; defaults to {}
              })
         })
```

## Implementation Plan

Build, Prove, Remove waves. Each wave is one commit. Deletion waves only run after verification.

### Wave 1: New awareness schema + helper (Build)

- [x] **1.1** Rewrite `packages/workspace/src/document/peer-identity.ts`. Replace `PeerIdentity` with `Replica`. New `peerAwarenessSchema = { replica, actionPaths }`. Export `Replica` and `Subject` types (`Subject = string`). _(landed earlier; peer-identity.ts also keeps legacy `PeerIdentity` alive until Wave 6 deletes it)_
- [x] **1.2** Add `createReplicaId({ storage })` helper in `packages/workspace/src/document/replica-id.ts`. Storage is the existing `SimpleStorage` shape (`{ getItem, setItem }`) so apps pass `localStorage` directly. First call generates a UUID and persists; subsequent calls return the persisted value. Persistence key is `epicenter.installation.id` so the legacy helper and the new helper share state during the transition.
- [x] **1.3** Unit tests: `Replica` schema accepts every supported platform and rejects unknown ones; `createReplicaId` / `createReplicaIdAsync` are idempotent and persist on first call.

### Wave 2: Server-side envelope (Build)

This wave is the one that needs the server-side reviewer per Open Question #1.

- [ ] **2.1** In `@epicenter/sync`, decide envelope format: either a new `MESSAGE_TYPE.AWARENESS_ATTESTED` that wraps the existing `MESSAGE_TYPE.AWARENESS` payload, or a sibling outer frame. Investigate existing `MESSAGE_TYPE` enum before committing.
- [ ] **2.2** Server: on ingress of an awareness frame from an authenticated WebSocket, derive `subject` from the session and emit the envelope-attested form to relayed peers. Client-published awareness payload is forwarded unchanged.
- [ ] **2.3** Server-side test: client publishes a forged subject in the payload; server's envelope `subject` is the auth-derived value, not the forgery.
- [ ] **2.4** Client supervisor: decode the new envelope kind; expose `subject` per clientID via a `peerMetadata` map.

### Wave 3: `openCollaboration` config migration (Build)

- [ ] **3.1** Change `OpenCollaborationConfig`: drop `identity`, add `replica: Replica`. `actions` becomes optional with default `{}`.
- [ ] **3.2** Inside `openCollaboration`, write awareness with `{ replica, actionPaths }`. Do not publish `subject` from the client; it is stamped on the wire.
- [ ] **3.3** Update `Collaboration` return type. Remove `identity`. Peers surface returns `Peer` with `clientID`, `subject`, `replica`, `actionPaths`.
- [ ] **3.4** Update `createPeersSurface` to join envelope subject (from supervisor's `peerMetadata`) with awareness payload (`replica`, `actionPaths`).

### Wave 4: Apps switch to `replica` (Build, Prove)

- [ ] **4.1** Each workspace constructor (`openFujiBrowser`, `openHoneycrispBrowser`, `openOpensidianBrowser`, `openZhongwenBrowser`, `openWhisperingBrowser`) drops the `peer` parameter, adds `replica: Replica`.
- [ ] **4.2** Each app constructs `replica` via `createReplicaId({ storage })` at boot. Platform is hard-coded per app (`'web'` for Svelte apps, `'tauri'` for desktop apps, etc.).
- [ ] **4.3** Wire opensidian content docs through `openCollaboration` (currently imports `attachYjsSync` but doesn't call it; remove the dead import or wire it through, depending on whether opensidian should sync content docs at all).
- [ ] **4.4** Each call site that previously read `peer.name` or `peer.identity` updates to read `peer.subject` (id only). Display name handling is deferred to its own spec; UIs that depended on `peer.name` show `peer.subject` as a placeholder until the lookup endpoint exists.
- [ ] **4.5** Full typecheck. Full test suite. Smoke each app: workspace opens, peers list populates, content doc opens and syncs, peer subject matches the auth user.

### Wave 5: Verify clean break (Prove)

- [ ] **5.1** Grep workspace package and apps for `attachYjsSync`. Confirm zero references outside the file itself.
- [ ] **5.2** Grep workspace package for `PeerIdentity`. Confirm zero references.
- [ ] **5.3** Grep workspace package for `peer:` workspace constructor arguments. Confirm all migrated to `replica:`.
- [ ] **5.4** Devtools network check: awareness frames over the wire carry the envelope; `subject` is the auth-derived value, not whatever the client might have tried to write.

### Wave 6: Delete old paths (Remove)

- [ ] **6.1** Delete `packages/workspace/src/document/attach-yjs-sync.ts`. Delete `YjsSyncAttachment` and `AttachYjsSyncConfig` types.
- [ ] **6.2** `SyncSupervisorConfig`: make `awareness`, `onActionRequest`, `onRuntimeRequest` required. Delete every null-check on these fields in `sync-supervisor.ts` (lines 344, 373, 384, 388, 398, 408, 562).
- [ ] **6.3** Move `toWsUrl` out of `sync-supervisor.ts` to a `transport/url.ts` or similar (it is not a supervisor concern).
- [ ] **6.4** Remove the `SelfInvocationError` wire fallback (`open-collaboration.ts:136-148`). With server-attested subject, server rejects same-subject self-RPC at ingress.
- [ ] **6.5** Confirm no `PeerIdentity` type or import remains. The type and its file go.

## Edge Cases

### Multi-tab on same device, same workspace

1. User opens workspace in tab A and tab B.
2. Both tabs read the same `replica.id` from persistent storage.
3. Yjs assigns each tab a distinct `clientID`. Server stamps the same `subject` on both.
4. Peers see: two entries with same `subject`, same `replica`, distinct `clientID`. UI may collapse or show separately (taste).

### Logout / relogin mid-session

1. User signs out. Auth state changes.
2. The application-level auth observer disposes the workspace (`workspace[Symbol.dispose]()`).
3. WebSocket closes; supervisor's existing teardown path runs; all docs in the cache release.
4. New auth state, new workspace open, new collaboration session.

No special workspace-internal wiring needed: auth-state changes are an application concern, not a sync-layer concern.

### Server cannot attest (auth missing or expired)

1. Client connects with no or expired token.
2. Existing 4401 permanent-failure close code fires. No awareness frames are exchanged.
3. Covered by the existing path; no new logic needed.

## Open Questions

1. **Envelope wire format inside `@epicenter/sync`: new `MESSAGE_TYPE` or wrap existing?**
   - Options:
     - (a) **New `MESSAGE_TYPE.AWARENESS_ATTESTED`** carrying `{ subject: string, payload: <existing awareness bytes> }`. Old AWARENESS becomes client-to-server; new ATTESTED becomes server-to-peers.
     - (b) Wrap inline with a varint prefix on the existing AWARENESS frame, server-side only.
   - **Recommendation**: (a). Cleaner directionality (client never sends ATTESTED; server never sends bare AWARENESS to peers). Cost is one enum entry and one decoder branch in the supervisor.
   - **Needs**: server reviewer with `@epicenter/sync` parsers in their head before this wave lands.

2. **`presence` key in awareness schema, later — single optional key or namespaced extensions?**
   - When cursors/status/typing arrive, where do they live? One `presence` blob or app-defined per-doc fields?
   - **Recommendation**: Defer. Decide when the first real consumer lands. Schema is per-key validated so additions are cheap.

## Decisions Log

- **Keep `createDisposableCache` for content docs.** Constraint: load-bearing for multi-component observers on the same body, fast back-navigation, optimistic write upload past dispose, split views, reactive query reads, HMR survival. Six concrete UI patterns break without it.
  Revisit when: real UI evidence that refcount + grace doesn't pay for itself in any consumer.

- **Keep `platform` in `replica` (not server-stamped).** Constraint: server can read User-Agent at WS upgrade but UA parsing is messy and platform is per-install, not per-connection. Client-side runtime detection is reliable.
  Revisit when: server gains a reliable per-install platform signal (e.g., a registered-device API).

- **Keep `actionPaths` as a top-level awareness key (not nested under `replica`).** Constraint: peers surface consumes it independently from `replica`; nesting adds an irrelevant dependency.
  Revisit when: peers and replica resolution become tightly coupled in some feature.

- **No `presence` key in this spec.** Constraint: schema is field-keyed and validated per-key; adding a field later is a one-line schema change, not a wire migration. Adding it now is YAGNI.
  Revisit when: cursors, status, or typing-indicator features are scheduled.

- **No display name handling in this spec.** Constraint: display data is mid-session mutable (rename) and structurally different from identity; needs a lookup endpoint and a cache layer that don't belong in this refactor.
  Revisit when: rename UX or avatars become a product requirement.

## Success Criteria

- [ ] Zero references to `attachYjsSync` in `apps/` or `packages/`.
- [ ] Zero references to `PeerIdentity` in `apps/` or `packages/`.
- [ ] All workspace constructors accept `replica: Replica`; none accept `peer: PeerIdentity`.
- [ ] `SyncSupervisorConfig`: `awareness`, `onActionRequest`, `onRuntimeRequest` are required. Null-checks on these fields in `sync-supervisor.ts` are deleted.
- [ ] Awareness payload validates against `peerAwarenessSchema = { replica, actionPaths }`. No `subject` in the payload.
- [ ] Server stamps `subject` on the envelope from the auth session. A test confirms a client-forged subject in the payload is ignored.
- [ ] `openCollaboration` accepts `actions` as optional, defaults to `{}`. Content docs construct it without `actions`.
- [ ] `toWsUrl` is no longer exported from `sync-supervisor.ts`.
- [ ] `SelfInvocationError` wire fallback in `open-collaboration.ts` is removed.
- [ ] Workspace package typechecks. Full test suite passes.
- [ ] Manual smoke: open fuji, honeycrisp, zhongwen, whispering, opensidian. Peers list shows correct subject. Content docs lazy-load and sync. Two-tab scenario shows two clientIDs with one subject + replica.

## References

- `packages/workspace/src/document/peer-identity.ts` (the file being reshaped)
- `packages/workspace/src/document/open-collaboration.ts` (the one document primitive after collapse)
- `packages/workspace/src/document/attach-yjs-sync.ts` (deleted in Wave 6)
- `packages/workspace/src/document/internal/sync-supervisor.ts` (nullable fields removed in Wave 6)
- `packages/workspace/src/document/peer.ts` (peers surface; updated in Wave 3)
- `packages/workspace/src/cache/disposable-cache.ts` (unchanged; load-bearing)
- `packages/sync/` (server protocol; envelope frame added in Wave 2)
- `apps/fuji/src/routes/(signed-in)/fuji/browser.ts` (canonical workspace constructor; migrated Wave 4)
- `apps/honeycrisp/src/routes/(signed-in)/honeycrisp/browser.ts`
- `apps/opensidian/src/lib/opensidian/browser.ts` (dead `attachYjsSync` import; fix in Wave 4)
- `apps/zhongwen/src/routes/(signed-in)/zhongwen/browser.ts`
- `apps/whispering/` (canonical workspace constructor; migrated Wave 4)
