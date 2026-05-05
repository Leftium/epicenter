# Sign-out preserves owner-scoped local data

**Date**: 2026-05-04
**Status**: Draft, revised after grill
**Author**: AI-assisted, grilled by Braden
**Branch**: not started
**Supersedes**: `specs/20260504T231540-attach-sync-trim-to-supervisor-superseded.md`
**Related, modifies, or deletes scope from**:
- `specs/20260414T143000-safe-sign-out-flow.md`: refused by this spec
- `specs/20260310T235239-sync-status-102.md`: protocol removed by this spec
- `specs/sync-client-simplification.md`: earlier removal of SYNC_STATUS in old `packages/sync-client`
- `specs/20260501T221831-auth-workspace-lifecycle-inversion.md`: the lifecycle binding this spec reshapes
- `specs/20260504T020000-workspace-identity-reset-deterministic-teardown.md`: the deterministic teardown contract this spec narrows to memory teardown plus owner-scoped local persistence

## One-sentence thesis

> **Sign-out destroys the live workspace and reloads; sign-in opens only the local cache scoped to that authenticated owner.**

That sentence replaces the earlier draft sentence. The earlier version said sign-out was a no-op in `bindAuthWorkspaceScope`. That is wrong: a no-op preserves the in-memory keyring and decrypted projections. Sign-out must be a runtime teardown. It must not be a storage wipe.

## What changed after the grill

The original draft had the right smell and the wrong boundary. It correctly noticed that the safe-sign-out gate exists only because sign-out wipes local data. It missed three load-bearing invariants.

1. **Identity mismatch is not durable today.** `appliedUserId` lives only in a closure in `packages/auth-workspace/src/index.ts`. If sign-out stops wiping and the app later boots as a different user, the first identity would apply with `appliedUserId === null`. A persisted owner marker can patch that, but identity-scoped local persistence is cleaner: the app never opens the prior user's cache in the first place.

2. **Sign-out cannot be an auth-workspace no-op.** `attachEncryption` has no `deactivateEncryption()` API. `EncryptedYKeyValueLww` documents encryption as one-way: once keys are applied, destroying the wrapper is the only reset path. A signed-out UI with the old workspace still alive still has decrypted data reachable through tables, KV, Svelte stores, and child document state.

3. **Not all persisted IndexedDB data is ciphertext.** Root encrypted table and KV values are encrypted after keys are applied, but Yjs metadata, row keys, table names, and LWW timestamps are plaintext. More importantly, Fuji, Honeycrisp, Opensidian, and Skills have persisted child documents backed by plaintext rich text or timeline attachments. The earlier claim that "IndexedDB stays as ciphertext" was too broad.

4. **`hasLocalChanges` is weaker than the safe-sign-out story says.** `attach-sync.ts` increments `localVersion` on local updates, but it does not publish `hasLocalChanges: true` when the local update happens. The popover can read stale `hasLocalChanges: false` during the unsynced window it was supposed to protect.

5. **The Bitwarden analogy is lock, not logout.** Official Bitwarden docs distinguish unlock from login: locking deletes decrypted vault data and keys from memory while preserving encrypted local vault data for offline unlock. Logout is a stronger account exit. Epicenter's target behavior is closer to Bitwarden lock plus auth-session removal, not Bitwarden logout.

## Product sentence

The product behavior we want is:

```txt
Signing out makes this running app unable to read workspace data, and sign-in resumes from the local cache scoped to that authenticated owner.
```

The behavior we refuse is:

```txt
Signing out proves every local edit reached the server before it lets the user leave.
```

That refusal deletes the SYNC_STATUS protocol, the safe-sign-out confirmation dialog, and the `hasLocalChanges` field. The safety boundary moves to owner-scoped local persistence, storage encryption, and runtime teardown.

## Asymmetric wins pass

### Refuse the safe-sign-out pre-check

Product sentence:

```txt
Sign-out preserves owner-scoped local persistence and makes the live app forget the workspace.
```

Candidate refusal:

```txt
Before sign-out, ask the sync server whether every local edit has been echoed.
```

Code family it deletes:

```txt
MESSAGE_TYPE.SYNC_STATUS
encodeSyncStatus / decodeSyncStatus
localVersion / ackedVersion / syncStatusTimer
server echo branch
hasLocalChanges on SyncStatus.connected
account-popover confirmation branch
safe-sign-out copy
protocol tests and daemon/CLI status payload branches
```

User loss:

```txt
No "Sign out anyway?" warning when offline edits exist.
```

Decision:

```txt
Refuse it. Sign-out no longer deletes local edits, so the warning protects the old bug.
```

### Refuse live signed-out workspace mode

Product sentence:

```txt
Sign-out makes this running app unable to read workspace data.
```

Candidate refusal:

```txt
After sign-out, keep the app mounted and keep the Y.Doc alive.
```

Code family it deletes:

```txt
deactivateEncryption API
table and KV unreadable states
Svelte store auth gates around every derived collection
child document key clearing
multi-tab memory invalidation protocol
signed-out workspace shell state
```

User loss:

```txt
Sign-out reloads the app instead of leaving the same mounted shell on screen.
```

Decision:

```txt
Refuse live signed-out workspace mode. Reload is the clean boundary. It clears JS memory, keyrings, decrypted projections, pending observers, and child document caches with one invariant.
```

### Refuse per-app preserve flags

Product sentence:

```txt
Only owner-scoped local persistence that is encrypted or deliberately non-sensitive may survive sign-out.
```

Candidate refusal:

```txt
Let each app opt into preserve-on-sign-out even if some of its persisted child docs are plaintext.
```

Code family it deletes:

```txt
per-app sign-out policy flags
shared AccountPopover branching
docs that explain which apps are "safe enough"
manual smoke matrices for mixed privacy semantics
future bug reports where one app preserves plaintext and another wipes
```

User loss:

```txt
Apps with plaintext child persistence cannot adopt preserve-on-sign-out until their persisted data is encrypted or explicitly classified as non-sensitive.
```

Decision:

```txt
Refuse per-app preserve flags. Fix the persistence boundary or keep the old wipe. Do not ship mixed privacy semantics through the shared sign-out component.
```

### Refuse direct `localStorage` inside auth-workspace

Product sentence:

```txt
The auth-workspace binding decides lifecycle transitions; apps provide runtime-specific persistence and reload capabilities.
```

Candidate refusal:

```txt
Have `@epicenter/auth-workspace` import or assume `window.localStorage`.
```

Code family it deletes:

```txt
browser-only package behavior
Chrome extension storage exceptions
test shims for window globals
future Tauri or daemon special cases
```

User loss:

```txt
Each app derives a local workspace scope from the authenticated identity before constructing the workspace.
```

Decision:

```txt
Refuse hidden localStorage. The preferred design does not need a security-critical owner marker at all. If a fallback marker is needed for migration, inject it instead of importing localStorage.
```

### Refuse fixed local persistence keys

Product sentence:

```txt
Sign-in opens only the local cache scoped to the authenticated owner.
```

Candidate refusal:

```txt
Keep IndexedDB and BroadcastChannel keyed only by ydoc.guid, then detect owner mismatch after opening.
```

Code family it deletes:

```txt
ownerStore as security boundary
wipe-before-apply transition
marker tampering edge cases
first-owner vs same-owner branching
wipe failure retry semantics
different-user cache mounting risk
```

User loss:

```txt
Different users on the same browser profile keep separate local caches. Old caches remain until a future "Forget this device" cleanup deletes them.
```

Decision:

```txt
Refuse fixed local persistence keys. Scope local persistence and local broadcast by authenticated owner before constructing the workspace.
```

## Current state

### Sign-out path today

```txt
account-popover.svelte
  read sync.status
  if connected and !hasLocalChanges:
    auth.signOut()
  else:
    confirmationDialog.open(...)
      onConfirm -> auth.signOut()

auth.signOut()
  clears credential
  emits identity null

bindAuthWorkspaceScope
  identity null after applied user
    resetLocalClient()

each app resetLocalClient
  bundle.wipe()
    destroy Y.Doc
    wait for idb/sync disposal
    clear IndexedDB databases
  reload
```

Current `bindAuthWorkspaceScope` callers:

```txt
apps/fuji/src/lib/fuji/client.ts
apps/honeycrisp/src/lib/honeycrisp/client.ts
apps/opensidian/src/lib/opensidian/client.ts
apps/tab-manager/src/lib/tab-manager/client.ts
apps/zhongwen/src/lib/zhongwen/client.ts
```

Current `AccountPopover` consumers:

```txt
apps/fuji/src/lib/components/AppHeader.svelte
apps/honeycrisp/src/lib/components/Sidebar.svelte
apps/opensidian/src/lib/components/editor/TabBar.svelte
apps/tab-manager/src/entrypoints/sidepanel/App.svelte
```

Whispering is not in this path. Current `apps/whispering/src` has no auth client, no `AccountPopover`, no `bindAuthWorkspaceScope`, no `attachSync`, and no sign-out flow. Its `<ConfirmationDialog />` mount is for unrelated destructive UI.

### SYNC_STATUS today

```txt
packages/sync/src/protocol.ts
  MESSAGE_TYPE.SYNC_STATUS = 100
  encodeSyncStatus()
  decodeSyncStatus()

packages/workspace/src/document/attach-sync.ts
  SyncStatus.connected has hasLocalChanges
  local updates increment localVersion
  debounce sends SYNC_STATUS(localVersion)
  echoed SYNC_STATUS updates ackedVersion

apps/api/src/sync-handlers.ts
  SYNC_STATUS is echoed unchanged

packages/svelte-utils/src/account-popover/account-popover.svelte
  reads hasLocalChanges for sign-out gate

packages/workspace/src/daemon/run-errors.ts
packages/workspace/src/daemon/run-handler.ts
packages/cli fixtures and tests
  still carry hasLocalChanges in the daemon/CLI status shape
```

The UI consumer dies with the sign-out gate. The daemon and CLI payload branches are cleanup fallout.

### Persistence today

Root encrypted stores:

```txt
attachEncryption(ydoc)
  workspace id = ydoc.guid
  user key -> deriveWorkspaceKey(userKey, workspaceId)
  table/KV value -> XChaCha20-Poly1305 encrypted blob
```

Plaintext still present in root IndexedDB:

```txt
database name = ydoc.guid
object stores = updates, custom
Yjs shared type names = table:<name>, kv
row or KV keys
LWW timestamps
Yjs structural updates
```

Persisted child docs currently not covered by `attachEncryption`:

```txt
apps/fuji/src/lib/fuji/browser.ts
  entry content child docs use attachIndexedDb plus rich text/timeline state

apps/honeycrisp/src/lib/honeycrisp/browser.ts
  note body child docs use attachIndexedDb plus rich text/timeline state

apps/opensidian/src/lib/opensidian/browser.ts
  file content child docs use attachIndexedDb plus rich text/timeline state

apps/skills/src/lib/skills/browser.ts
  instruction/reference docs use attachIndexedDb plus plaintext document attachments
```

This is a blocker for the original thesis. Preserving local persistence on sign-out is only acceptable for persistence that is encrypted or deliberately classified as non-sensitive.

## Desired lifecycle

The clean break is to construct browser-local workspace persistence only after the app knows the authenticated owner. A signed-out app should not mount the workspace at all.

```txt
SIGNED_OUT:
  auth identity = null
  no workspace runtime
  no IndexedDB provider
  no BroadcastChannel provider
  sign-in UI only

SIGNED_IN_USER_A:
  auth identity = user A
  local scope = user:<ownerHash>
  ydoc.guid = epicenter.fuji
  IndexedDB key = epicenter:v1:user:<ownerHash>:yjs:epicenter.fuji
  BroadcastChannel key = epicenter:v1:user:<ownerHash>:yjs:epicenter.fuji
  sync URL = /workspaces/epicenter.fuji
  encryption info = workspace:epicenter.fuji
  apply user A keys

SIGN_OUT:
  auth identity -> null
  destroy live workspace runtime
  keep owner-scoped local persistence
  reload to signed-out app

SIGNED_IN_USER_B:
  auth identity = user B
  local scope = user:<otherOwnerHash>
  open a different IndexedDB key
  open a different BroadcastChannel key
  apply user B keys
```

Different-user sign-in does not need to wipe user A's cache because user A's cache is never opened. Wipe becomes an explicit cleanup feature: "Forget this device" deletes owner-scoped local Yjs caches.

## Local Yjs key

Server Durable Object names already use owner-first hierarchy:

```txt
user:{userId}:workspace:{workspaceId}
user:{userId}:document:{documentId}
```

Do not copy that shape into browser persistence. Durable Objects route product resources. IndexedDB persistence stores Yjs documents. The only local persistence invariant is:

```txt
authenticated owner + ydoc.guid -> local Yjs provider name
```

Use a deterministic local owner id derived from the auth user id, then combine it with the Y.Doc guid.

Recommended local key shape:

```txt
epicenter:v1:user:{userId}:yjs:{ydocGuid}
```

Where:

```txt
userId   = identity.user.id, the auth identity's stable opaque user id
ydocGuid = ydoc.guid, for example epicenter.fuji or epicenter.fuji.entries.<entryId>.content
```

This keeps the natural owner → Yjs document hierarchy. The user id is already an opaque random string assigned by Better Auth and IndexedDB names are per-origin (no cross-site visibility), so hashing the id buys nothing functional. The local key is a stable namespace label, not a cryptographic access boundary. Security still comes from not mounting the wrong cache, clearing memory on sign-out, and encrypting persisted values.

If a future deployment wants opaque local labels (e.g., to defend against a malicious extension snooping IDB names within the same origin), wrap `userId` in a one-line hash at the helper boundary; today nothing requires it.

Do not change `ydoc.guid`. It remains the CRDT identity, sync room name, child document namespace, and HKDF workspace label. The new local keys are storage and local-broadcast names only.

## Proposed API shape

The exact names can change during implementation, but the ownership should not.

```ts
function createLocalYjsKey(userId: string, ydocGuid: string): string;

const localKey = createLocalYjsKey(identity.user.id, ydoc.guid);

attachIndexedDb(ydoc, {
	persistenceKey: localKey,
});

attachBroadcastChannel(ydoc, {
	channelKey: localKey,
});
```

That is the low-level shape. The preferred call site should be even smaller so apps cannot scope IndexedDB and forget BroadcastChannel:

```ts
attachBrowserLocalYjs(ydoc, {
	userId: identity.user.id,
	transportOrigin: SYNC_ORIGIN,
});
```

`attachBrowserLocalYjs` owns one invariant: browser-local Yjs persistence and browser-local Yjs broadcast use the same owner-scoped local key. It can return the IndexedDB attachment because callers still need `whenLoaded`, `clearLocal`, and `whenDisposed`.

Child documents use the same rule. There is no separate child-doc persistence API:

```ts
const documentGuid = entryContentDocGuid({ workspaceId: doc.ydoc.guid, entryId });
const ydoc = new Y.Doc({ guid: documentGuid, gc: false });

const childIdb = attachBrowserLocalYjs(ydoc, {
	userId: identity.user.id,
	transportOrigin: SYNC_ORIGIN,
});
```

`@epicenter/auth-workspace` should become smaller in this model. It no longer needs to compare durable owners. Its job is to sequence "auth became null, destroy and reload" and "auth became present, apply keys to an already owner-scoped workspace."

## Design decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Sign-out local disk behavior | Design coherence | Preserve owner-scoped local persistence | Sign-out should not destroy offline work. The app must still drop the live runtime. |
| Sign-out runtime behavior | Evidence | Destroy runtime and reload | Encryption wrappers have no key-clearing API. Destroying the Y.Doc and reloading is the existing hard boundary. |
| Different-user behavior | Evidence | Open a different local cache | Root metadata and child docs can expose prior-user structure or plaintext. The clean boundary is not opening another owner's cache. |
| Owner tracking | Clean break | Avoid owner marker as security boundary | Durable markers patch fixed cache names. Owner-scoped persistence removes the mismatch branch. |
| Owner hash | Asymmetric win | Refuse — use raw user id | Better Auth user ids are already opaque random strings; IndexedDB names are per-origin. Hashing adds a helper, tests, and a "is the hash stable across versions?" worry without functional benefit. If a future threat model needs opacity (malicious extension snooping IDB names), wrap at the helper boundary then. |
| Local BroadcastChannel | Evidence | Scope it with the same local key | IndexedDB isolation alone is incomplete if cross-tab Yjs updates still share `ydoc.guid`. |
| SYNC_STATUS | Asymmetric win | Delete it | With sign-out no longer deleting local edits, the only UI consumer disappears. |
| `hasLocalChanges` | Asymmetric win | Delete it from `SyncStatus` and daemon shapes | No current product surface needs it after the gate dies. Reintroduce an explicit save-barrier API later if needed. |
| Plaintext child docs | Evidence | Block preserve-on-sign-out until solved | The privacy claim is false for Fuji, Honeycrisp, Opensidian, and Skills child docs today. |
| Reload after sign-out | Clean boundary | Required | Optional reload keeps live signed-out workspace mode alive. Refuse it. |
| "Forget this device" | Deferred | Out of scope | It is a real future destructive action, but it is not required to delete SYNC_STATUS or fix sign-out semantics. |
| Bitwarden comparison | Evidence | Use lock as analogy, not logout | Official docs describe lock as deleting decrypted data from memory while keeping local encrypted vault data. |
| `SyncWebSocket` structural type | Asymmetric win | Refuse — use `WebSocket` directly | The implementation reads `WebSocket.OPEN`/`CLOSED`/`CLOSING`/`CONNECTING` as DOM globals plus `/// <reference lib="dom" />`. The structural type is a fiction that pretends portability the impl never delivered. Collapsing it removes ~15 LOC and one mental model. |
| Structured logging on attach-sync | Quality | Add `log.info` on terminal status transitions, `log.warn` on permanent close-code parse | 2 `log.warn` calls in 1130 LOC means production debugging has no breadcrumbs. The `Logger` is already plumbed through; the cost is 4-5 lines. |
| `bindAuthWorkspaceScope` callback shape | Clean break | Two explicit callbacks: `onSignOut`, `onIdentityChanged`. Both required. No defaults. | The two events are semantically different (user-initiated vs different-user-detected). Today both bodies will be `window.location.reload()` because there is no `deactivateEncryption()` API and the bundle-level dispose isn't audited for completeness — reload is the only verifiable cleanup boundary. The callbacks exist as seams for: lifecycle naming at the call site, test injection, platform-specific overrides (Tauri window close, Chrome extension sidepanel), and per-event telemetry. They are NOT about "different reset strategies" today; they are about giving apps a place to express the truth (`reload` for both) without hiding it behind a default. |
| `resetLocalClient` callback name | Clean break | Delete the name. | After this spec, no destructive reset happens on identity transitions. The local IDB is preserved on sign-out and a different IDB opens on identity change. The callback name was honest when it wiped; it lies now. Lifecycle-shaped names (`onSignOut`, `onIdentityChanged`) replace it. |
| Reload-as-cleanup-boundary | Evidence | Document explicitly | Bitwarden, 1Password, Notion, and Linear all use page navigation on logout for the same reason: apps with non-trivial in-memory state cannot reliably enumerate every store, listener, observer, and cache that holds decrypted data. Reload moves the cleanup boundary up to the OS process layer, where verification is automatic. A future spec can build `attachEncryption(...).deactivate()` + audited `bundle.dispose()` and let apps opt into in-process teardown; this spec does not. |

## Architecture

### Before

```txt
sign out click
  |
  v
AccountPopover checks hasLocalChanges
  |
  v
auth.signOut()
  |
  v
identity null
  |
  v
bindAuthWorkspaceScope reset()
  |
  v
app wipe()
  |
  +-- destroy runtime
  +-- clear IndexedDB
  +-- reload

Support code:
  SYNC_STATUS protocol
  hasLocalChanges status payload
  confirmation dialog copy
```

### After

```txt
sign out click
  |
  v
auth.signOut()
  |
  v
identity null
  |
  v
destroy owner-scoped workspace runtime
  |
  +-- destroy runtime
  +-- keep local persistence
  +-- reload

same owner signs in later
  |
  v
attachBrowserLocalYjs(ydoc, { userId: identity.user.id })
  |
  v
open scoped IndexedDB and BroadcastChannel
  |
  v
applyAuthIdentity(identity)

different owner signs in later
  |
  v
attachBrowserLocalYjs(ydoc, { userId: newIdentity.user.id })
  |
  v
open a different IndexedDB and BroadcastChannel key
  |
  v
applyAuthIdentity(identity)
```

The new boundary is simple: sign-out destroys memory, and local persistence is owner-scoped before anything mounts.

## Implementation plan

### Phase 0: Verify blockers

- [ ] **0.1** Confirm which current `bindAuthWorkspaceScope` apps have only encrypted persisted data and which have plaintext child docs. Current finding: Fuji, Honeycrisp, Opensidian, and Skills have plaintext child docs; tab-manager and Zhongwen need final confirmation.
- [ ] **0.2** Decide whether this PR encrypts child docs or keeps preserve-on-sign-out blocked until a child-doc encryption spec lands. Recommendation: do not ship preserve-on-sign-out for plaintext child-doc apps.
- [ ] **0.3** Confirm every current app `wipe()` clears all child databases, not only the root document. Fuji, Honeycrisp, and Opensidian manually clear child docs today.
- [ ] **0.4** Confirm no app outside `bindAuthWorkspaceScope` wipes local persistence on identity-null transitions.
- [ ] **0.5** Confirm `attachSync` already drops offline when credentials disappear. Current finding: auth change triggers reconnect, active cycle aborts, and `openWebSocket()` returning null leaves status offline.

### Phase 1: Add scoped local Yjs identity helpers

- [ ] **1.1** Add a small key helper in `packages/workspace` or `packages/auth-workspace`: `createLocalYjsKey(userId, ydocGuid)`.
- [ ] **1.2** Use one owner-scoped Yjs key shape: `epicenter:v1:user:{userId}:yjs:{ydocGuid}`.
- [ ] **1.3** Use the raw `identity.user.id` directly. No hashing, no domain-separation label. User ids are already opaque random strings assigned by Better Auth and IndexedDB names are per-origin.
- [ ] **1.4** Add tests proving different users produce different keys and the key shape matches `epicenter:v1:user:<userId>:yjs:<ydocGuid>` exactly.

### Phase 2: Separate Y.Doc identity from local browser keys

- [ ] **2.1** Change `attachIndexedDb(ydoc)` to accept optional `{ persistenceKey }`, defaulting to `ydoc.guid`.
- [ ] **2.2** Ensure both `new IndexeddbPersistence(...)` and `clearLocal()` use the same `persistenceKey`.
- [ ] **2.3** Change `attachBroadcastChannel(ydoc)` to accept optional `{ channelKey }`, defaulting to the current `ydoc.guid` behavior.
- [ ] **2.4** Document that `persistenceKey` and `channelKey` are local runtime names only. They do not change sync room names, `ydoc.guid`, child document GUIDs, or HKDF workspace labels.
- [ ] **2.5** Add `attachBrowserLocalYjs(ydoc, { userId, transportOrigin })` as the preferred browser attach primitive. It computes one local key and passes it to both `attachIndexedDb` and `attachBroadcastChannel`.
- [ ] **2.6** Add focused tests for the key plumbing where practical. If y-indexeddb is hard to test directly, test returned `clearLocal()` behavior with a small browser-compatible harness or document the manual verification.

### Phase 3: Auth-scope workspace construction

For each current caller:

```txt
apps/fuji/src/lib/fuji/client.ts
apps/honeycrisp/src/lib/honeycrisp/client.ts
apps/opensidian/src/lib/opensidian/client.ts
apps/tab-manager/src/lib/tab-manager/client.ts
apps/zhongwen/src/lib/zhongwen/client.ts
```

- [ ] **3.1** Stop constructing browser-local workspaces before auth identity is known for participating apps.
- [ ] **3.2** On signed-in auth, pass `identity.user.id` into browser workspace construction.
- [ ] **3.3** Use `attachBrowserLocalYjs(doc.ydoc, { userId: identity.user.id, transportOrigin })` for root local persistence and local broadcast.
- [ ] **3.4** Use `attachBrowserLocalYjs(childYdoc, { userId: identity.user.id, transportOrigin })` for every persisted child document.
- [ ] **3.5** Keep `ydoc.guid` unchanged for sync URLs and encryption. Root sync still points to `/workspaces/${doc.ydoc.guid}`. Child sync should use `/documents/${ydoc.guid}`.
- [ ] **3.6** On sign-out, destroy the current workspace runtime and reload. Do not call `clearLocal()` or `clearDocument()`.
- [ ] **3.7** Keep destructive local deletion only for explicit "Forget this device" or legacy wipe paths.

### Phase 4: Close the plaintext child-doc gap

This phase is required before the shared popover can preserve local data in Fuji, Honeycrisp, Opensidian, or any app with persisted plaintext child docs.

- [ ] **4.1** Choose one child-doc encryption strategy in a separate focused spec if it is not obvious during implementation.
- [ ] **4.2** Audit every persisted child document factory that calls `attachIndexedDb`.
- [ ] **4.3** Either encrypt the persisted child content or explicitly classify it as non-sensitive with product sign-off.
- [ ] **4.4** Add manual smoke for local disk inspection: after sign-out, root and child persisted user content must not be readable without keys.

Recommendation: do not add an app-level `preserveLocalOnSignOut` flag to bypass this. That creates two privacy products behind one shared UI.

### Phase 5: Collapse the popover

- [ ] **5.1** Edit `packages/svelte-utils/src/account-popover/account-popover.svelte`. Replace `handleSignOut` with a direct `auth.signOut()` call and normal error toast.
- [ ] **5.2** Remove the `confirmationDialog` import from the account popover.
- [ ] **5.3** Remove "safe sign-out" wording from the component JSDoc.
- [ ] **5.4** Do not remove root `<ConfirmationDialog />` mounts blindly. Fuji, Whispering, Skills, Tab-manager, Opensidian, and others use confirmation dialogs for unrelated destructive actions.
- [ ] **5.5** Remove "Sign out with unsynced changes?", "Sign out anyway", and "Stay signed in" strings.

### Phase 6: Delete SYNC_STATUS and `hasLocalChanges`, clean up `attach-sync.ts`

- [ ] **6.1** `packages/workspace/src/document/attach-sync.ts`: remove the `encodeSyncStatus` import, version counters, timer, debounced send, SYNC_STATUS message case, and `hasLocalChanges` from `SyncStatus.connected`.
- [ ] **6.2** `packages/sync/src/protocol.ts`: remove `MESSAGE_TYPE.SYNC_STATUS`, `encodeSyncStatus`, `decodeSyncStatus`, and SYNC_STATUS docs.
- [ ] **6.3** `packages/sync/src/index.ts`: remove SYNC_STATUS exports.
- [ ] **6.4** `apps/api/src/sync-handlers.ts`: remove the SYNC_STATUS echo branch. Keep text `ping` to `pong`; it is unrelated liveness behavior.
- [ ] **6.5** Update `packages/workspace/src/daemon/run-errors.ts` and `packages/workspace/src/daemon/run-handler.ts` so connected status has no `hasLocalChanges` payload.
- [ ] **6.6** Update CLI tests and fixtures that still construct `{ phase: 'connected', hasLocalChanges: false }`.
- [ ] **6.7** Update `packages/workspace/SYNC_ARCHITECTURE.md`, `packages/sync/README.md`, and any docs/articles that describe SYNC_STATUS.

#### Phase 6.A: Refuse the `SyncWebSocket` structural type (Cut F)

`attach-sync.ts:181-196` defines a structural type that mirrors a subset of `WebSocket`. The intent was to let non-DOM transports satisfy the interface. The actual implementation reads `WebSocket.OPEN`/`CLOSED`/`CLOSING`/`CONNECTING` as DOM globals at lines 474, 563, 646, 654, 775, 921, 1011, 1040, plus a `/// <reference lib="dom" />` at line 1. The type pretends to be portable; the implementation is browser-only. That mismatch is the smell.

- [ ] **6.A.1** Delete the `SyncWebSocket` type from `attach-sync.ts`.
- [ ] **6.A.2** Change `SyncAuth.openWebSocket` return type from `SyncWebSocket | null` to `WebSocket | null`.
- [ ] **6.A.3** Update `packages/auth/src/create-auth.ts` (`openWebSocket` signature) and any other implementer to return `WebSocket | null` directly.
- [ ] **6.A.4** Mark `specs/20260504T185711-attach-sync-auth-namespace.md` as superseded by this cut, since its rationale ("`WebSocket` is a strict superset of `SyncWebSocket`") is now resolved by collapsing them.

Why this is a clean break and not just a rename: keeping `SyncWebSocket` as an alias for `WebSocket` would preserve the fiction that the abstraction does something. It does not. Delete the name; commit to the dependency that already exists.

#### Phase 6.B: Add structured logging breadcrumbs (Cut H)

The current `attach-sync.ts` has 1130 lines and 2 `log.warn` calls. Production debugging of "why is sync stuck?" is blind.

- [ ] **6.B.1** In the supervisor's status-emitter `set` path, emit `log.info` on each terminal transition: `connected`, `failed`, `offline`. Do not log `connecting` (would spam during retry loops).
- [ ] **6.B.2** When `parsePermanentFailure` returns non-null, emit `log.warn` with the close code and parsed reason.
- [ ] **6.B.3** When the supervisor exits the loop (after master abort), emit `log.info` with the cause: dispose, doc destroyed, or permanent failure.
- [ ] **6.B.4** Do not log inside the inner reconnect loop (would spam at backoff intervals). The status transition already covers visibility.
- [ ] **6.B.5** Use the file's existing logger source (`createLogger('attachSync')`); do not introduce per-call logger instantiation.

### Phase 7: Rename and split the auth-workspace lifecycle callback (Cut G)

The current `bindAuthWorkspaceScope({ resetLocalClient })` callback fires on both sign-out and identity mismatch and is named for a destructive action that no longer happens. Replace it with two lifecycle-shaped callbacks, both required:

```ts
bindAuthWorkspaceScope({
  auth,
  applyAuthIdentity(session) {
    fuji.encryption.applyKeys(session.encryptionKeys);
  },
  onSignOut() {
    window.location.reload();
  },
  onIdentityChanged() {
    window.location.reload();
  },
});
```

- [ ] **7.1** `packages/auth-workspace/src/index.ts`: change `AuthWorkspaceScopeOptions` type. Replace `resetLocalClient: () => Promise<void>` with two required fields: `onSignOut: () => void | Promise<void>` and `onIdentityChanged: () => void | Promise<void>`.
- [ ] **7.2** `packages/auth-workspace/src/index.ts`: in `processIdentity`:
  - When `identity === null && appliedUserId !== null` → `await onSignOut()`. Do NOT call any local-data wipe. The IDB stays.
  - When `identity !== null && appliedUserId !== null && appliedUserId !== userId` → `await onIdentityChanged()`. Do NOT call any local-data wipe. The new user's scoped IDB will open after reload.
- [ ] **7.3** Drain semantics: callbacks fire on terminal transitions and the binding stops processing further identity changes for the current page lifetime (a reload is expected, but the binding shouldn't depend on it actually happening — fields like `isResetting` keep the existing single-shot drain behavior, just renamed).
- [ ] **7.4** `packages/auth-workspace/src/index.test.ts`: rewrite tests around the new callbacks. Add a test asserting that NEITHER callback's body is invoked by the binding itself (the binding only fires the callback; the callback decides whether to reload).
- [ ] **7.5** Update the 5 callers (`apps/fuji/src/lib/fuji/client.ts`, `apps/honeycrisp/src/lib/honeycrisp/client.ts`, `apps/opensidian/src/lib/opensidian/client.ts`, `apps/tab-manager/src/lib/tab-manager/client.ts`, `apps/zhongwen/src/lib/zhongwen/client.ts`). Body for each callback is `window.location.reload()` for now. Apps may diverge later; today they don't need to.
- [ ] **7.6** Delete each app's `wipe()` method on the workspace bundle if no consumer remains (grep first). The wipe was load-bearing for the old `resetLocalClient`; with sign-out and identity-change both reloading without a wipe, `wipe()` is destructive cleanup that only "Forget this device" would call — defer until that ships.
- [ ] **7.7** Update `docs/encryption.md` and `docs/guides/consuming-epicenter-api.md` examples to show the two-callback shape. Explain in prose: both bodies will usually be `window.location.reload()`; the seams exist for naming, tests, platform overrides, and telemetry.

### Phase 8: Supersede old specs and docs

- [ ] **8.1** Mark `specs/20260414T143000-safe-sign-out-flow.md` as superseded by this spec.
- [ ] **8.2** Mark `specs/20260310T235239-sync-status-102.md` as superseded by this spec.
- [ ] **8.3** Mark `specs/20260504T185711-attach-sync-auth-namespace.md` as superseded (Cut F collapses `SyncWebSocket` into `WebSocket`).
- [ ] **8.4** Update docs that say sign-out wipes local data, but only after the child-doc encryption blocker is resolved.
- [ ] **8.5** Replace Bitwarden logout claims with the more precise lock analogy and link to official Bitwarden unlock vs login docs.

### Phase 9: Verify

- [ ] **9.1** Run `bun test packages/auth-workspace/src/index.test.ts`.
- [ ] **9.2** Run `bun test packages/sync/src/protocol.test.ts`.
- [ ] **9.3** Run `bun test packages/workspace/src/document/attach-sync.test.ts`.
- [ ] **9.4** Run daemon and CLI tests touched by `SyncStatus` shape changes.
- [ ] **9.5** Run `bun run typecheck`.
- [ ] **9.6** Manual smoke per participating app: sign in, edit, sign out, confirm runtime reloads (via `onSignOut`) and local persistence remains under the same owner-scoped key.
- [ ] **9.7** Manual smoke per participating app: sign in as a different user after sign-out and reload, confirm a different local cache opens and the prior user's cache is not mounted.
- [ ] **9.8** Manual smoke for local disk: persisted user content that survives sign-out is encrypted or deliberately non-sensitive.
- [ ] **9.9** Manual smoke: confirm `onSignOut` fires once per user-initiated sign-out and `onIdentityChanged` fires once per different-user transition (not both for the same event).

## Edge cases

### Same user signs out and returns after reload

```txt
auth identity = null
workspace runtime = destroyed by reload
local cache = epicenter:v1:user:<hashA>:workspace:epicenter.fuji

later:
auth identity = user A
local cache = epicenter:v1:user:<hashA>:workspace:epicenter.fuji
apply keys
same owner-scoped local cache resumes
```

### Different user signs in after a signed-out reload

```txt
prior local cache = epicenter:v1:user:<hashA>:workspace:epicenter.fuji
auth identity = user B
new local cache = epicenter:v1:user:<hashB>:workspace:epicenter.fuji
apply user B keys
```

User A's cache remains on disk but is not opened. It can be removed later by "Forget this device."

### Multi-tab sign-out

Sign-out should broadcast auth null through the existing auth client. Each tab destroys its owner-scoped runtime and reloads. No tab calls `clearLocal()`, so there is no IDB delete race.

### Different user while another tab still has old runtime

The tab that sees the auth change destroys and reloads. Other tabs may have old decrypted state until their auth change or reload fires. This is already a multi-tab runtime problem today. The clean fix is still to reload on terminal transitions. Do not replace reload with a custom invalidation protocol in this spec.

### Offline edits

Offline edits are local Yjs updates. Sign-out preserves owner-scoped local persistence and destroys memory. Same-owner sign-in later reloads the updates from IDB and sync resumes. Different-owner sign-in opens a different cache.

### Key rotation

Same-owner sign-in with a rotated keyring still works for root encrypted stores if the keyring includes the old version. `applyKeys` converges old-version ciphertext to the current version. If old keys are revoked, old local data is undecryptable. That is a key-management outcome, not a sign-out outcome.

## Open questions

1. **What is the child-doc encryption strategy?**
   - Recommendation: block preserve-on-sign-out for apps with plaintext child docs until this has its own design. The current spec should not launder plaintext persistence through an "encrypted local data" claim.

2. **How long should orphaned owner caches survive?**
   - Recommendation: defer automatic pruning. Add explicit "Forget this device" first. Browser storage pressure can handle old caches until users ask for cleanup.

3. **Should failed runtime teardown block sign-out completion?**
   - Recommendation: sign-out already happened at the auth layer. If teardown fails, show an error and reload anyway. The goal is to clear memory. A reload is the recovery path.

4. **Should raw user id ever appear in local keys?**
   - **Yes.** User ids are already opaque random strings (Better Auth assigns them); IndexedDB names are per-origin and not exposed cross-site. The asymmetric-win pass refused the hash: it added a helper, tests, and a stability worry without functional benefit. Reopen this only if a future threat model (e.g., a malicious browser extension reading IDB names within the same origin) makes opacity load-bearing.

5. **Should `hasLocalChanges` come back later as save status?**
   - **Refused permanently.** Yjs is a continuous-sync CRDT; there is no "saved" event in the data model. Apple Notes, Apple Keychain, Bitwarden, Signal, and Obsidian all ship without a "saved/saving…" indicator. A future SYNC_STATUS revival would re-introduce the same wire/UI/state machine cost for a UX surface no peer product considers necessary. If a future product surface genuinely needs an atomic save barrier (rare; usually a sign that the product wants Yjs's eventual semantics replaced with transactional semantics, which is a different system), design that as an explicit invariant with its own primitive. Do not bring back a "I think the server has it" heuristic.

## Success criteria

- [ ] Participating apps construct browser-local workspaces only after auth identity is known.
- [ ] Local IndexedDB keys are owner-scoped with owner-first hierarchy.
- [ ] Local BroadcastChannel keys are owner-scoped with the same local hierarchy.
- [ ] Sign-out destroys runtime and reloads, not a storage wipe and not a no-op.
- [ ] A signed-out app reload has no live Y.Doc, encryption keyring, decrypted table projection, child document cache, or sync socket from the prior user.
- [ ] Different-owner sign-in opens a different local cache before applying keys.
- [ ] `ydoc.guid` remains the sync room, child GUID namespace, and encryption workspace id.
- [ ] No app hides reload inside `resetLocalClient`; the lifecycle binding owns when terminal transitions reload.
- [ ] No `MESSAGE_TYPE.SYNC_STATUS`, `encodeSyncStatus`, `decodeSyncStatus`, `localVersion`, `ackedVersion`, `syncStatusTimer`, or `hasLocalChanges` remains in live source, docs, daemon payloads, or CLI fixtures.
- [ ] No `SyncWebSocket` type alias remains. `auth.openWebSocket` returns `WebSocket | null`.
- [ ] `attach-sync.ts` emits `log.info` on each terminal status transition and `log.warn` on permanent-failure parse.
- [ ] `bindAuthWorkspaceScope` accepts two required callbacks: `onSignOut` and `onIdentityChanged`. The old `resetLocalClient` parameter is gone everywhere.
- [ ] All 5 app callers pass `window.location.reload()` for both callbacks (or a documented platform-specific override).
- [ ] No app's workspace bundle exposes `wipe()` unless a "Forget this device" consumer exists in the same PR.
- [ ] `account-popover.svelte` has no confirmation dialog branch for sign-out.
- [ ] Apps with plaintext child docs either keep wipe-on-sign-out or have encrypted child persistence before preserve-on-sign-out ships.
- [ ] `specs/20260414T143000-safe-sign-out-flow.md` and `specs/20260310T235239-sync-status-102.md` are marked superseded.

## References

Code paths verified during the grill:

```txt
packages/auth-workspace/src/index.ts
packages/auth-workspace/src/index.test.ts
packages/svelte-utils/src/account-popover/account-popover.svelte
packages/workspace/src/document/attach-sync.ts
packages/workspace/src/document/attach-encryption.ts
packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts
packages/workspace/src/document/attach-indexed-db.ts
packages/sync/src/protocol.ts
apps/api/src/sync-handlers.ts
apps/fuji/src/lib/fuji/client.ts
apps/honeycrisp/src/lib/honeycrisp/client.ts
apps/opensidian/src/lib/opensidian/client.ts
apps/tab-manager/src/lib/tab-manager/client.ts
apps/zhongwen/src/lib/zhongwen/client.ts
packages/workspace/src/daemon/run-errors.ts
packages/workspace/src/daemon/run-handler.ts
```

External grounding:

- Official Bitwarden docs: `https://bitwarden.com/help/understand-log-in-vs-unlock/`
- Official Bitwarden docs: `https://bitwarden.com/help/unlock-with-pin/`
- DeepWiki on `yjs/y-protocols`: standard protocol families are sync, awareness, and auth. SYNC_STATUS is not standard.

## Final one-sentence test

After implementation, this must be true:

> **Sign-out destroys the live workspace and reloads; sign-in opens only the local cache scoped to that authenticated owner.**

If any surviving code path keeps a live signed-out workspace, uses unscoped local IndexedDB or BroadcastChannel names for authenticated workspaces, deletes local persistence on same-owner sign-out, or keeps SYNC_STATUS alive only for the old sign-out warning, the implementation is incomplete.
