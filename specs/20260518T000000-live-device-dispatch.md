# Live-device dispatch over the relay

Date: 2026-05-18
Status: planned
Owner: Braden

## 1. Context

Today's cross-device RPC, `collab.dispatch`, writes call rows into a `YKeyValueLww<Call>` keyspace in the workspace Y.Doc. The relay (Cloudflare Durable Object in `apps/api/src/room.ts`) syncs the keyspace to every connected peer. Each peer's observer filters by `to === selfConnId` and drops the rest.

This works, but it's wrong on three axes:

1. **Fan-out.** A call addressed to one device is replicated to every connected device. At realistic scale (5 devices, 10 calls per minute) every peer sees ~5.76 MB of dispatch traffic per day it does not care about. On a laptop, invisible. On a Chrome extension service worker or a phone background task, every replicated frame wakes the runtime. Wakeup amplification is the real cost.

2. **CRDT history bloat.** Every call is two writes (request, response) plus a tombstone on sweep, all entering the relay's SQLite update log until compaction. Long-lived hot rooms accumulate dispatch churn linearly.

3. **Fake durability.** The CRDT promises eventual delivery. RPC wants "right now, or fail." The orphan sweep in `open-collaboration.ts:162-176` is the confession: rows must expire because they were never durable workspace state in the first place.

The fix is to route dispatch through the relay's existing per-socket addressing (`ctx.acceptWebSocket(server, [replicaId])`) as a sibling wire-frame, not through CRDT rows. The relay already holds a live `Y.Doc`, already enforces presence-keyspace write rules, and already maintains a `connections` map. Adding one more typed frame kind is small.

## 2. Target state

```
Workspace W on the relay (one Durable Object):

  ┌──────────────────────────────────────────────────────────┐
  │ Durable Object: workspace/W                              │
  │                                                          │
  │   sockets tagged by replicaId:                           │
  │     { R_laptop → ws1, R_phone → ws2, R_daemon → ws3 }    │
  │                                                          │
  │   devices: Map<replicaId, { displayName, actions }>      │
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

Refused: anycast / capability-based addressing (`{ to: { capability: 'X' } }`). Every dispatch carries a concrete `to: replicaId`. Selection by capability is a client-side helper at most.

### 3.2 One call shape: `dispatch`

No `fire` / `send` / `job` taxonomy. One verb. If the recipient is online, the call is delivered. If not, `RecipientOffline` is returned synchronously. The caller decides whether to retry.

### 3.3 Two identities: `replicaId` (stable) and `connId` (per-socket)

- `replicaId` is the stable install identity. It is the address used in `dispatch({ to: replicaId, ... })`.
- `connId` is per-socket. It is internal to the relay (the WebSocket attachment tag). It is not part of the public API.

The relay accepts sockets with `ctx.acceptWebSocket(ws, [replicaId])` and resolves `replicaId → current socket(s)` via `ctx.getWebSockets(replicaId)` at delivery time.

### 3.4 No `platform` field on devices

Earlier drafts included a `platform` tag (`desktop`, `daemon`, `browser`, etc). It is removed. The only reason `platform` existed was to predict capabilities, but each device already advertises its actions directly. The action list is strictly more useful than the platform tag.

Device rows are: `{ replicaId, displayName, actions }`. Three fields. Anything else is speculative.

### 3.5 Server adds `from` on inbound frames; responses reuse dispatch routing

The relay is authoritative for "who sent this." When a `dispatch` frame arrives from a socket, the relay forwards it as `dispatch_inbound` with `from` set from the socket's `replicaId` attachment, not from the caller's self-report.

Responses are symmetric: the recipient writes `dispatch_response { id, to: from, result }` and the relay routes it back exactly like a dispatch. The relay does not keep per-id pending state.

### 3.6 Multi-socket per replicaId: forward to all, first response wins

If two browser tabs of the same install hold sockets tagged with the same `replicaId`, `ctx.getWebSockets(replicaId)` returns both. The relay forwards `dispatch_inbound` to both. Both tabs run the handler. The first `dispatch_response` is forwarded to the caller; subsequent ones are dropped client-side (the caller's pending map has no entry for that id once resolved).

This implies action handlers must be idempotent. That is the protocol contract. Document it.

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
      to: string,                  // replicaId
      action: string,              // snake_case key
      input: unknown,
      expiresAt: number }          // ms epoch

  dispatch_response
    { kind: 'dispatch_response',
      id: string,
      to: string,                  // original caller's replicaId
      result: Result<unknown, ActionError> }

server → client

  device_list
    { kind: 'device_list',
      devices: LiveDevice[] }      // full snapshot, sent on connect

  device_changed
    { kind: 'device_changed',
      added: LiveDevice[],
      removed: string[] }          // replicaIds

  dispatch_inbound
    { kind: 'dispatch_inbound',
      id: string,
      from: string,                // replicaId, server-assigned
      action: string,
      input: unknown,
      expiresAt: number }

  dispatch_response                // forwarded from recipient to caller
    { kind: 'dispatch_response',
      id: string,
      result: Result<unknown, ActionError> }

  dispatch_error                   // routing errors only
    { kind: 'dispatch_error',
      id: string,
      error: { name: 'RecipientOffline' } }

type LiveDevice = {
  replicaId: string
  displayName: string
  actions: string[]
}
```

### 4.1 End-to-end flow

```
caller R_laptop                relay (DO)                  recipient R_phone
─────────────                  ──────────                  ─────────────────
dispatch { id: 'a1',           ┐
          to: 'R_phone',       │
          action: 'open_note', │
          input: {...},        │
          expiresAt: t+30s }  ─┘
                                │
                                ├─ ctx.getWebSockets('R_phone')
                                │      → [ws_phone]   (or [] if offline)
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
    replicaId: string
    device: {
      displayName: string
      actions:     TActions
    }
  },
): {
  replicaId: string
  status:    'connecting' | 'live' | 'offline'

  devices: {
    list():                          LiveDevice[]
    get(rid: string):                LiveDevice | undefined
    subscribe(fn: (d: LiveDevice[]) => void): () => void
  }

  dispatch<K extends keyof TActions & string>(req: {
    to:        string                       // replicaId
    action:    K
    input:     InferInput<TActions[K]>
    expiresAt: number                       // ms epoch
    signal?:   AbortSignal
  }): Promise<Result<InferOutput<TActions[K]>, DispatchError>>

  [Symbol.asyncDispose](): Promise<void>
}

type DispatchError =
  | { name: 'RecipientOffline' }
  | { name: 'ActionNotFound' }
  | { name: 'ActionFailed', cause: unknown }
  | { name: 'Expired' }
```

`InferInput` and `InferOutput` extract the schema-typed input and the handler return type from each action in the registry. Same pattern as today's `dispatch<T>(...)`.

## 6. Failure modes

| Scenario                                  | Caller observes               |
|-------------------------------------------|-------------------------------|
| Recipient not online at send time         | `RecipientOffline`            |
| Recipient disconnects mid-handler         | `Expired` (no response)       |
| Recipient handler throws                  | `ActionFailed`                |
| Recipient lacks the action                | `ActionNotFound`              |
| Caller's socket drops before response     | promise rejects via signal    |
| `expiresAt` passes before response        | `Expired`, resolves on timer  |
| `expiresAt` is in the past at send time   | throws synchronously at call  |

The expiry timer runs client-side. The server does not need to enforce `expiresAt`; if the recipient is slow, the caller hits its local deadline and resolves `Expired`.

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
  • return: replicaId, status, devices, dispatch, asyncDispose

packages/workspace/src/daemon/run-handler.ts
  • peerTarget path now calls the new dispatch; error mapping updated.

packages/workspace/src/daemon/run-errors.ts
  • RemoteCallFailed mapping reflects the new DispatchError variants.

apps/api/src/room.ts
  • add devices: Map<replicaId, DeviceMeta>
  • handle device_register, dispatch, dispatch_response frames
  • on socket close: remove device entry, broadcast device_changed
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

### Multi-tab handler races

Risk: Two tabs of one install both run the handler. Side effects double up.

Mitigation: Document the idempotency contract. For actions that cannot tolerate it, callers use a dedup mechanism inside the handler (workspace-state-as-lock, not protocol-level). If a real "exactly once across tabs" use case shows up, it is a follow-up spec.

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
Is a device online?              Durable Object's in-memory devices Map
                                 (mirrored to clients via device_list/changed).
Who sent this dispatch?          Server-stamped `from` on dispatch_inbound.
                                 Recipient never trusts caller self-report.
Dispatch routing                 ctx.getWebSockets(replicaId) in the DO.
                                 Synchronous. No CRDT involvement.
Action registry                  Per-device, declared at openCollaboration time.
                                 Mirrored into the device's LiveDevice row.
Dispatch error taxonomy          DispatchError variants in
                                 packages/workspace/src/document/dispatch.ts.
                                 Three handler-level + one routing-level + Expired.
Identity                         replicaId (stable per install) is the public address.
                                 connId is internal to the relay.
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
- Stripping or refactoring Yjs awareness; it keeps its current role.

## 12. Verification at completion

- `packages/workspace/src/document/rpc.ts` is gone.
- Orphan sweep block in `open-collaboration.ts` is gone.
- A dispatch in a workspace with N=5 devices produces exactly one outbound socket write at the relay (not N-1 fan-out).
- The relay's SQLite update log no longer grows from dispatch traffic.
- Chrome extension service worker is not woken by dispatches addressed to other devices.
- A fresh deploy passes the existing daemon `/run` end-to-end tests with the new dispatch underneath.
- `collab.devices.list()` reflects connect/disconnect events within one RTT of socket open/close.
- Multi-tab same-install: both tabs handle a dispatch; caller resolves on the first response.
