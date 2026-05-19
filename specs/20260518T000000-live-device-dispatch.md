# Live-device dispatch over the relay

Date: 2026-05-18
Status: planned
Owner: Braden

## 1. Context

Today's cross-device RPC, `collab.dispatch`, writes call rows into a `YKeyValueLww<Call>` keyspace in the workspace Y.Doc. The relay (Cloudflare Durable Object in `apps/api/src/room.ts`) syncs the keyspace to every connected peer. Each peer's observer filters by `to === selfConnectionId` and drops the rest.

This works, but it's wrong on three axes:

1. **Fan-out.** A call addressed to one device is replicated to every connected device. At realistic scale (5 devices, 10 calls per minute) every peer sees ~5.76 MB of dispatch traffic per day it does not care about. On a laptop, invisible. On a Chrome extension service worker or a phone background task, every replicated frame wakes the runtime. Wakeup amplification is the real cost.

2. **CRDT history bloat.** Every call is two writes (request, response) plus a tombstone on sweep, all entering the relay's SQLite update log until compaction. Long-lived hot rooms accumulate dispatch churn linearly.

3. **Fake durability.** The CRDT promises eventual delivery. RPC wants "right now, or fail." The orphan sweep in `open-collaboration.ts:162-176` is the confession: rows must expire because they were never durable workspace state in the first place.

The fix is to route dispatch through the relay's existing per-socket addressing (`ctx.acceptWebSocket(server, [installationId])`) as a sibling wire-frame, not through CRDT rows. The relay already holds a live `Y.Doc`, already enforces presence-keyspace write rules, and already maintains a `connections` map. Adding one more typed frame kind is small.

## 2. Target state

```
Workspace W on the relay (one Durable Object):

  ┌──────────────────────────────────────────────────────────┐
  │ Durable Object: workspace/W                              │
  │                                                          │
  │   sockets tagged by installationId:                           │
  │     { R_laptop → ws1, R_phone → ws2, R_daemon → ws3 }    │
  │                                                          │
  │   devices: Map<installationId, { displayName, actions }>      │
  │     rebuilt from WebSocket attachments after hibernation │
  │   live Y.Doc (existing, unchanged)                       │
  │                                                          │
  │   wire message kinds:                                    │
  │     • sync               (Yjs, existing)                 │
  │     • awareness          (y-protocols, existing)         │
  │     • device_register    (NEW)                           │
  │     • device_list        (NEW)                           │
  │     • device_changed     (NEW)                           │
  │     • dispatch           (NEW)                           │
  │     • dispatch_inbound   (NEW)                           │
  │     • dispatch_response  (NEW)                           │
  │     • dispatch_error     (NEW)                           │
  └──────────────────────────────────────────────────────────┘
```

The Y.Doc keeps durable workspace state. Dispatch lives on a sibling frame on the same socket. The two never touch.

Devices are discovered through the relay (the source of truth for liveness), not through the doc or awareness. There is no durable device registry. Offline devices do not exist for the purpose of dispatch.

## 3. Explicit decisions

### 3.1 Live-only discovery and dispatch

A device is visible if and only if it has an open socket on the relay right now. There is no durable `devices` table, no last-seen tracking, no retirement workflow, no stale-device sweep.

Refused: offline-deferred dispatch, "send this to my phone when it next wakes." If a real use case appears, it gets a separate primitive with its own claim, lease, retry, and dedup invariants. Not this one.

Refused: anycast / capability-based addressing (`{ to: { capability: 'X' } }`). Every dispatch carries a concrete `to: installationId`. Selection by capability is a client-side helper at most.

### 3.2 One call shape: `dispatch`

No `fire` / `send` / `job` taxonomy. One verb. If the recipient is online, the call is delivered. If not, `RecipientOffline` is returned synchronously. The caller decides whether to retry.

`RecipientOffline` is the only no-delivery result. Once the relay forwards `dispatch_inbound`, the protocol cannot tell whether a later `Expired` means "the handler never ran," "the handler is still running," or "the handler ran its side effect and failed before responding." Retry safety belongs to the action contract, not the dispatch protocol.

### 3.3 Two identities: `installationId` (stable) and `connectionId` (per-socket)

- `installationId` is the stable install identity. It is the address used in `dispatch({ to: installationId, ... })`.
- `connectionId` is per-socket. It is internal to the relay (the WebSocket attachment tag). It is not part of the public API.

The relay accepts sockets with `ctx.acceptWebSocket(ws, [installationId])` and resolves `installationId → one active socket` at delivery time.

Device metadata is hibernation-restorable socket state. When the relay handles `device_register`, it serializes `{ installationId, displayName, actions, activeForDispatch }` into the WebSocket attachment. When the Durable Object wakes with hibernated sockets, it rebuilds the in-memory device map by scanning `ctx.getWebSockets()`, deserializing attachments, and selecting the socket whose attachment has `activeForDispatch: true`.

### 3.4 No `platform` field on devices

Earlier drafts included a `platform` tag (`desktop`, `daemon`, `browser`, etc). It is removed. The only reason `platform` existed was to predict capabilities, but each device already advertises its actions directly. The action list is strictly more useful than the platform tag.

Device rows are: `{ installationId, displayName, actions }`. Three fields. Anything else is speculative.

### 3.5 Server adds `from` on inbound frames; `from` is a routing label

The relay is authoritative for which accepted socket sent a frame. When a `dispatch` frame arrives from a socket, the relay forwards it as `dispatch_inbound` with `from` set from the socket's registered `installationId`, not from the caller's per-frame self-report.

For v1, `installationId` is a trusted routing label inside the authenticated room, not a cryptographic device identity. A client cannot override `from` on an individual dispatch frame, but a client that can open a socket for the room can still choose which `installationId` it registers. Action handlers must not treat `from` as an authorization principal.

Room authorization is checked when `apps/api/src/app.ts` handles the WebSocket upgrade and forwards the request to the Durable Object. The Durable Object does not revalidate OAuth tokens or Better Auth sessions per dispatch frame. Token or session revocation takes effect when the socket reconnects or closes, not immediately on an already-open socket.

Responses are symmetric: the recipient writes `dispatch_response { id, to: from, result }` and the relay routes it back exactly like a dispatch. The relay does not keep per-id pending state.

### 3.6 Multi-socket per installationId: one active dispatch socket

If two browser tabs of the same install hold sockets tagged with the same `installationId`, the relay does not forward `dispatch_inbound` to both. Exactly one socket is active for dispatch and device metadata. Registering a newer socket for the same `installationId` replaces the active socket. Older sockets can keep syncing the Y.Doc and awareness, but they are not dispatch recipients.

On replacement, the relay updates the old active socket's attachment to `activeForDispatch: false` and the new socket's attachment to `activeForDispatch: true`. On active socket close, the relay promotes another registered socket for that `installationId` if one exists and updates that attachment to `activeForDispatch: true`; otherwise it removes the device row and broadcasts `device_changed`. Refused: same-install dispatch fan-out. A caller that wants to run an action in every tab needs a separate client-side loop over concrete socket identities; it is not the default `installationId` dispatch contract.

### 3.7 Awareness stays as is

Yjs awareness keeps its current role: ephemeral state that every peer genuinely cares about (cursors, typing indicators, true presence). Dispatch discovery does not use awareness. Two mechanisms, two distinct purposes.

### 3.8 Protocol portability is a value, not a deliverable for v1

The dispatch protocol is intentionally implementable on any WebSocket server, not just Cloudflare Durable Objects. The DO is an optimization (free hibernation, tagged sockets), not a requirement.

This spec does not ship a `bun.serve()` reference implementation. Self-hosters who want the relay today can run their own Cloudflare Workers + Durable Objects with the existing `apps/api` code. A non-Cloudflare reference impl is a future spec.

## 4. Wire protocol

Frames are added to the existing WebSocket between client and relay, alongside the existing `sync`, `awareness`, and `presence` frames.

```
client → server

  device_register
    { kind: 'device_register', displayName: string, actions: string[] }

  dispatch
    { kind: 'dispatch',
      id: string,                  // caller-generated, ULID/nanoid
      to: string,                  // installationId
      action: string,              // snake_case key
      input: unknown,
      expiresAt: number }          // ms epoch

  dispatch_response
    { kind: 'dispatch_response',
      id: string,
      to: string,                  // original caller's installationId
      result: Result<unknown, ActionResponseError> }

server → client

  device_list
    { kind: 'device_list',
      devices: LiveDevice[] }      // full snapshot, sent on connect

  device_changed
    { kind: 'device_changed',
      upserted: LiveDevice[],
      removed: string[] }          // installationIds

  dispatch_inbound
    { kind: 'dispatch_inbound',
      id: string,
      from: string,                // installationId, server-stamped routing label
      action: string,
      input: unknown,
      expiresAt: number }

  dispatch_response                // forwarded from recipient to caller
    { kind: 'dispatch_response',
      id: string,
      result: Result<unknown, ActionResponseError> }

  dispatch_error                   // routing errors only
    { kind: 'dispatch_error',
      id: string,
      error: { name: 'RecipientOffline' } }

type LiveDevice = {
  installationId: string
  displayName: string
  actions: string[]
}

type ActionResponseError =
  | { name: 'ActionNotFound' }
  | { name: 'ActionFailed', cause: unknown }
```

### 4.1 Frame validation

The relay validates every new dispatch frame before mutating `devices` or forwarding. Malformed frames are protocol violations: close the sender's socket with `4400 protocol-error`. They do not produce `dispatch_error`, because `dispatch_error` is reserved for valid dispatch frames that fail routing.

Validation rules:

- `device_register.displayName` must be a string with length `1..80`.
- `device_register.actions` must contain at most 20 unique action keys.
- Every action key in `device_register.actions` and `dispatch.action` must match `ACTION_KEY_PATTERN`.
- `dispatch.id` and `dispatch_response.id` must be non-empty strings with length at most 128.
- `dispatch.to` and `dispatch_response.to` must be non-empty installation ids with length at most 128.
- `dispatch.expiresAt` must be a finite safe integer.
- The serialized WebSocket attachment for the registered socket must remain under Cloudflare's 2 KB attachment limit.
- Existing WebSocket payload-size limits still apply to full frame payloads.

`device_changed.upserted` means replace the whole client-side row for that `installationId`. It covers both first appearance and active-socket replacement where `displayName` or `actions` changed. `removed` means delete the row.

### 4.2 End-to-end flow

```
caller R_laptop                relay (DO)                  recipient R_phone
─────────────                  ──────────                  ─────────────────
dispatch { id: 'a1',           ┐
          to: 'R_phone',       │
          action: 'open_note', │
          input: {...},        │
          expiresAt: t+30s }  ─┘
                                │
                                ├─ active socket for 'R_phone'
                                │      → ws_phone     (or none if offline)
                                │
                                │   if []: send back ─►  dispatch_error
                                │                       { id: 'a1',
                                │                         error: RecipientOffline }
                                │
                                │   otherwise forward ─► dispatch_inbound
                                │                       { id: 'a1',
                                │                         from: 'R_laptop',
                                │                         action, input, expiresAt }
                                │                                  │
                                │                                  ▼
                                │                              handler runs
                                │                                  │
              ◄── dispatch_response ─── dispatch_response  ◄───────┘
                  { id: 'a1',           { id: 'a1',
                    result }              to: 'R_laptop',
                                          result }
       ▲
       │
caller has a Promise keyed by 'a1',
resolves with result.
```

The key points:

1. The server reads its own `connections` index to answer "is the recipient connected?" synchronously. No CRDT round trip.
2. The server stamps `from` on `dispatch_inbound`. The recipient does not have to trust the caller's self-report.
3. `dispatch_response` reuses the same routing logic as `dispatch`. The recipient sets `to: from` and the server forwards. No per-id pending map on the server.
4. `dispatch_error` is only used for routing-level errors (recipient offline). Handler-level errors (`ActionNotFound`, `ActionFailed`) travel inside `dispatch_response.result`.

## 5. Public API

`openCollaboration` absorbs dispatch and discovery. It already requires the WebSocket, the identity, and the Yjs sync wiring; dispatch reuses all three.

```ts
// packages/workspace/src/document/open-collaboration.ts

export function openCollaboration<TActions extends ActionRegistry>(
  ydoc: Y.Doc,
  opts: {
    url:       string
    installationId: string
    device: {
      displayName: string
      actions:     TActions
    }
  },
): {
  installationId: string
  status:    'connecting' | 'live' | 'offline'

  devices: {
    list():                          LiveDevice[]
    get(rid: string):                LiveDevice | undefined
    subscribe(fn: (d: LiveDevice[]) => void): () => void
  }

  dispatch<TOutput = unknown>(req: DispatchRequest): Promise<Result<TOutput, DispatchError>>

  [Symbol.asyncDispose](): Promise<void>
}

type DispatchRequest = {
  to:        string                       // installationId
  action:    string
  input:     unknown
  expiresAt: number                       // ms epoch
  signal?:   AbortSignal
}

type DispatchFor<TTargetActions extends ActionRegistry> = <
  TAction extends keyof TTargetActions & string,
>(req: {
    to:        string                       // installationId
    action:    TAction
    input:     InferInput<TTargetActions[TAction]>
    expiresAt: number                       // ms epoch
    signal?:   AbortSignal
  }) => Promise<Result<InferOutput<TTargetActions[TAction]>, DispatchError>>

type DispatchError =
  | { name: 'RecipientOffline' }
  | ActionResponseError
  | { name: 'Cancelled', reason: unknown }
  | { name: 'Expired' }
```

`TActions` types this device's inbound action handlers only. It does not type outbound dispatch, because the recipient's registry is runtime-discovered as `LiveDevice.actions: string[]` and may differ from the caller's registry. The base dispatch API treats `action` and `input` as wire values (`string` and `unknown`) and defaults `result` to `unknown`.

Callers that know the target contract can import that action registry type and locally narrow dispatch:

```ts
import type { DispatchFor } from '@epicenter/workspace'
import type { TabManagerActions } from '@epicenter/tab-manager/actions'

const dispatchTabManager: DispatchFor<TabManagerActions> = collab.dispatch

await dispatchTabManager({
  to: tabManagerInstallationId,
  action: 'tabs_close',
  input: { tabIds: [1, 2] },
  expiresAt: Date.now() + 30_000,
})
```

That typed view is caller-asserted. The relay does not prove that a given `installationId` implements `TTargetActions`; it only routes to a live socket whose advertised action names include runtime strings.

## 6. Failure modes

| Scenario                                  | Caller observes               |
|-------------------------------------------|-------------------------------|
| Recipient not online at send time         | `RecipientOffline`            |
| Recipient disconnects mid-handler         | `Expired` (no response)       |
| Recipient handler throws                  | `ActionFailed`                |
| Recipient lacks the action                | `ActionNotFound`              |
| Caller aborts `signal` before response    | `Cancelled`                   |
| Caller socket drops before response       | response may arrive after reconnect; otherwise `Expired` |
| `expiresAt` passes before response        | `Expired`, resolves on timer  |
| `expiresAt` is in the past at send time   | throws synchronously at call  |

The expiry timer runs client-side. The server does not need to enforce `expiresAt`; if the recipient is slow, the caller hits its local deadline and resolves `Expired`.

The caller's pending map is owned by the local `openCollaboration` instance, not by one WebSocket connection. If the socket reconnects before `expiresAt`, a response routed back to the same `installationId` can still resolve the pending call. If the instance is disposed, abort pending calls with `Cancelled`.

`Expired` is an unknown-outcome result after delivery. It is safe to report to the user as no response by deadline. It is not safe to treat as "nothing happened" unless the action itself is idempotent or has its own dedup key.

## 7. Files affected

Remove:

```
packages/workspace/src/document/rpc.ts                       (entire file)
packages/workspace/src/document/open-collaboration.ts:162-176 (orphan sweep)
```

Update:

```
packages/workspace/src/document/open-collaboration.ts
  • drop attachActionRunner
  • drop YKeyValueLww<Call> usage
  • new signature: device.{displayName, actions}
  • return: installationId, status, devices, dispatch, asyncDispose

packages/workspace/src/daemon/run-handler.ts
  • peerTarget path now calls the new dispatch; error mapping updated.

packages/workspace/src/daemon/run-errors.ts
  • RemoteCallFailed mapping reflects the new DispatchError variants.

apps/api/src/room.ts
  • add devices: Map<installationId, DeviceMeta>
  • handle device_register, dispatch, dispatch_response frames
  • validate dispatch frame shapes before mutating devices or forwarding
  • store device metadata and activeForDispatch in WebSocket attachments
  • rebuild devices and active dispatch sockets from attachments after hibernation
  • on active socket close: promote another socket for that installationId or remove device entry, broadcast device_changed
  • deprecate the presence YKeyValueLww keyspace

apps/api/src/sync-handlers.ts
  • add cases for the new top-level kinds

packages/sync/...
  • wire-format version bump; new frame schemas
```

Add:

```
packages/workspace/src/document/dispatch.ts
  • client-side frame handler
  • dispatch() implementation
  • devices accessor
```

## 8. Migration

Single coordinated wire-format change. Client and relay deploy together. The new top-level frame kinds are not backward-compatible with the existing CRDT-based dispatch path.

Steps:

1. **Land server-side device map and frame handlers** (`apps/api`). Behind a feature flag if needed; the new frames are inert if no client sends them.
2. **Land client-side dispatch path** (`packages/workspace`). Replace `rpc.ts` with `dispatch.ts`; `openCollaboration` returns the new shape.
3. **Cut over** in one release. Existing in-flight CRDT call rows at deploy time are abandoned; they are ephemeral by design.
4. **Delete deprecated paths** (`rpc.ts`, orphan sweep, presence keyspace) after the cutover release is stable.

The daemon `/run` endpoint signature does not change. Its internal call to `collab.dispatch` swaps from CRDT-row write to the new frame-based path. CLI consumers see no difference.

## 9. Risks and mitigations

### `device_register` arrival timing

Risk: A socket can dispatch before its own `device_register` has been processed by the relay, racing.

Mitigation: Client-side gate. `dispatch()` awaits an internal `registered` promise that resolves when the relay echoes the device into the next `device_list` or `device_changed` frame. Cheap; happens once per connect.

### Snapshot vs incremental discovery ordering

Risk: A `device_changed` arrives before the initial `device_list` snapshot, leaving the client with an inconsistent view.

Mitigation: The relay always sends `device_list` first on accept. Clients ignore `device_changed` until snapshot has been received. Pin this with a test.

### Device metadata replacement

Risk: Same-install active socket replacement changes `displayName` or `actions`, but clients treat it as an append-only add and keep a stale row.

Mitigation: `device_changed.upserted` replaces the whole row by `installationId`. Pin this with a test: reconnect same `installationId` with a different action list, and clients observe exactly one updated row.

### Device metadata abuse

Risk: A buggy or hostile room member registers a giant display name or action list and forces every connected client to process it.

Mitigation: The relay validates `device_register` before storing or broadcasting it. Invalid metadata closes the sender with `4400 protocol-error`; it is never mirrored into `device_list` or `device_changed`.

### Auth revocation while sockets are open

Risk: An OAuth token or Better Auth session is revoked after a WebSocket upgrade, but the already-open socket can still send dispatch frames.

Mitigation: This is v1's auth boundary. The Worker authenticates the upgrade; the DO trusts accepted sockets until close. Immediate socket invalidation on token revocation is a follow-up primitive, not part of dispatch routing.

### Multi-tab active socket selection

Risk: Two tabs of one install both connect, and the relay picks the wrong one for dispatch.

Mitigation: Registering a newer socket for the same `installationId` makes it active for dispatch and device metadata. Older sockets remain sync participants only. Pin this with a test: same-install two-tab dispatch runs one handler, not two.

### Wire format version

Risk: Mixed-version clients connect to a relay that handles only the new format (or vice versa).

Mitigation: Bump the WebSocket subprotocol string. The relay refuses sockets that do not advertise the new subprotocol. Clients on old versions get a clear error and must upgrade.

### Self-host story regresses

Risk: Self-hosters cannot drop in a generic y-websocket server anymore.

Mitigation: This boat already sailed. `apps/api/src/room.ts` is a custom Cloudflare DO. Self-hosting today already means deploying the Cloudflare stack. Protocol portability is a value (section 3.8); a non-Cloudflare reference impl is a candidate follow-up spec when there is demand.

## 10. Source-of-truth map (after this spec lands)

```
Concern                          Single source of truth
───────────────────────────────  ─────────────────────────────────────────────────
Is a device online?              Durable Object's in-memory devices Map,
                                 rebuilt from WebSocket attachments and
                                 mirrored to clients via device_list/changed.
Which routing label sent this?   Server-stamped `from` on dispatch_inbound.
                                 Recipient never trusts per-frame caller
                                 self-report. `from` is not an auth principal.
Dispatch routing                 Active socket for installationId in the DO.
                                 Synchronous. No CRDT involvement.
Action registry                  Per-device, declared at openCollaboration time.
                                 Mirrored into the device's LiveDevice row.
Dispatch error taxonomy          DispatchError variants in
                                 packages/workspace/src/document/dispatch.ts.
                                 Three handler-level + one routing-level +
                                 Cancelled + Expired.
Identity                         installationId (stable per install) is the public address.
                                 connectionId is internal to the relay.
```

## 11. Out of scope

Deliberately not in this spec. Each is a candidate for a follow-up.

- Offline-deferred dispatch (queueing for not-yet-connected devices).
- Durable jobs (claim/lease/retry/dedup primitives).
- Anycast or capability-based addressing.
- User-level addressing (`{ to: { user: U } }`); a helper if/when needed.
- A non-Cloudflare reference relay implementation.
- Cross-workspace dispatch.
- Per-action ACL hooks beyond `ActionNotFound` (the registry's pre-existing capability check; trust comes from workspace membership for v1).
- Cryptographic per-install identity proof for `installationId`.
- Immediate socket invalidation on OAuth token or session revocation.
- Stripping or refactoring Yjs awareness; it keeps its current role.

## 12. Verification at completion

- `packages/workspace/src/document/rpc.ts` is gone.
- Orphan sweep block in `open-collaboration.ts` is gone.
- A dispatch in a workspace with N=5 devices produces exactly one outbound socket write at the relay (not N-1 fan-out).
- The relay's SQLite update log no longer grows from dispatch traffic.
- Chrome extension service worker is not woken by dispatches addressed to other devices.
- A fresh deploy passes the existing daemon `/run` end-to-end tests with the new dispatch underneath.
- `collab.devices.list()` reflects connect/disconnect events within one RTT of socket open/close.
- Multi-tab same-install: exactly one active tab handles a dispatch.
- Durable Object hibernation and wake preserves `collab.devices.list()` and the active dispatch socket for each `installationId`.
- Invalid `device_register` metadata closes only the sender and is not broadcast.
- Same-install active socket replacement upserts one device row rather than appending a duplicate.
