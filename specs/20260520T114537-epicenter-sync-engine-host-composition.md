# Epicenter Sync Engine Host Composition

**Date**: 2026-05-20
**Status**: Draft
**Author**: AI-assisted

## Overview

Epicenter sync should move down one abstraction layer: the core package should expose a sync engine that host applications compose into their own routes, not a full relay server that owns auth hooks, billing hooks, or product policy.

Epicenter Cloud, a solo self-host server, and an enterprise host should all call the same sync engine. They differ in route ownership, authentication, billing, and policy. The engine only owns Yjs room mechanics.

## One Sentence

Epicenter Sync is a Yjs room engine that host applications compose after authorization; it does not own users, auth sessions, billing, or access-control policy.

Shorter versions:

```txt
Host routes decide who may enter. SyncEngine decides how the room syncs.

The engine owns Yjs mechanics. The host owns policy.

Move the boundary down one layer: compose routes around an engine, not hooks into a relay.
```

## Current State

The current Cloudflare API already has the rough shape, but the boundary is not named as a reusable engine yet.

```txt
apps/api/src/app.ts
  authenticates /rooms/*
  resolves c.var.user
  builds a subject-scoped Durable Object room name
  forwards HTTP sync, WebSocket upgrade, and dispatch to Room

apps/api/src/room.ts
  trusts the Worker boundary
  owns Yjs document state
  owns WebSockets
  owns awareness
  owns dispatch correlation
  owns Durable Object persistence
```

That is close to the desired ownership split:

```txt
Host route:
  auth
  policy
  billing
  route errors

Room runtime:
  Yjs sync
  persistence
  awareness
  dispatch
```

The missing abstraction is the reusable layer between them.

## Why Not Hooks

Hooks feel attractive when a generic relay wants to stay policy-free while still reporting stateful effects back to the host.

```ts
createSyncRelay({
  resolveAccess,
  onRoomAccess,
  onStorageBytesChanged,
  onDisconnect,
});
```

That shape is a smell here. It means the relay owns the effect while the host owns the decision.

```txt
host owns billing
relay observes bytes

host owns revocation
relay owns open sockets

host owns deletion policy
relay owns stored updates
```

The cleaner model is composition:

```ts
const access = await requireRoomAccess(c);
const result = await sync.handleHttpSync(c.req.raw, {
  roomName: access.roomName,
});

await recordUsage({
  subject: access.subject,
  room: access.room,
  bytesWritten: result.bytesWritten,
  storageBytes: result.storageBytes,
});

return result.response;
```

The hook disappears because the host route is the composer.

## Architecture

```txt
Browser SPA
  IndexedDB
  live Yjs docs
  encryption keys
  offline edits
      |
      v
Host route
  auth
  policy
  billing
  route errors
      |
      v
SyncEngine
  HTTP sync
  WebSocket sync
  awareness
  dispatch
  room persistence
      |
      v
Room backend
  Cloudflare Durable Object
  local process
  test in-memory runtime
```

The engine has no idea whether the host used Better Auth, a reverse proxy, a shared secret, or enterprise IAM. It receives an already-authorized room name.

## Proposed Surface

```ts
export type SyncEngine = ReturnType<typeof createSyncEngine>;

export function createSyncEngine(
  {
    rooms,
  }: {
    rooms: SyncRooms;
  },
  options?: {
    maxPayloadBytes?: number;
  },
) {
  return {
    async handleWebSocket(
      request: Request,
      input: {
        roomName: string;
        installationId: string;
      },
    ) {
      // Upgrade, route to room, and return 101 response.
    },

    async handleHttpSync(
      request: Request,
      input: {
        roomName: string;
      },
    ) {
      // Decode sync request, route to room, and return response + metering.
      return {
        response,
        bytesWritten,
        storageBytes,
      };
    },

    async getSnapshot(roomName: string) {
      // Return encoded Yjs state for bootstrap.
    },

    async dispatch(roomName: string, request: DispatchRpcRequest) {
      // Route live-device dispatch through the room runtime.
    },

    async deleteRoom(roomName: string) {
      // Delete persisted room state.
    },
  };
}
```

The engine depends on room infrastructure, not auth infrastructure.

```ts
type SyncRooms = {
  get(roomName: string): SyncRoom;
};

type SyncRoom = {
  handleWebSocket(request: Request, input: { installationId: string }): Promise<Response>;
  sync(update: Uint8Array): Promise<{ diff: Uint8Array | null; storageBytes: number }>;
  getSnapshot(): Promise<{ data: Uint8Array; storageBytes: number }>;
  dispatch(request: DispatchRpcRequest): Promise<DispatchResult>;
  deleteStorage(): Promise<void>;
};
```

The exact method names can change during implementation. The important constraint is that the engine receives a resolved `roomName`, not a user session or auth client.

## Host Composition

### Epicenter Cloud

```ts
const sync = createSyncEngine({
  rooms: cloudflareDurableObjectRooms(c.env.ROOM),
});

app.use('/rooms/*', requireOAuthUser);

app.post('/rooms/:room', async (c) => {
  await requireBillingAllowsSync(c);

  const roomName = `subject:${c.var.user.id}:rooms:${c.req.param('room')}`;
  const result = await sync.handleHttpSync(c.req.raw, { roomName });

  c.var.afterResponse.push(
    recordSyncUsage({
      userId: c.var.user.id,
      room: c.req.param('room'),
      storageBytes: result.storageBytes,
    }),
  );

  return result.response;
});
```

Epicenter Cloud owns Better Auth, billing, Postgres metadata, and route errors. The sync engine owns the Yjs mechanics.

### Solo Self-Host

```ts
const sync = createSyncEngine({
  rooms: localRooms({ dir: './.epicenter/sync' }),
});

app.all('/rooms/:room/*', async (c) => {
  if (!hasSharedSecret(c.req.raw)) {
    return new Response('Unauthorized', { status: 401 });
  }

  return sync.handleWebSocket(c.req.raw, {
    roomName: `subject:solo:rooms:${c.req.param('room')}`,
    installationId: readInstallationId(c.req.raw),
  });
});
```

This mode can be intentionally small. It is for one person or a tiny trusted group. It should not pretend to support enterprise revocation.

### Enterprise Host

```ts
app.get('/rooms/:room', async (c) => {
  const user = await enterpriseIam.requireUser(c.req.raw);
  const allowed = await enterpriseAcl.canSyncRoom({
    user,
    room: c.req.param('room'),
  });

  if (!allowed) return new Response('Forbidden', { status: 403 });

  return sync.handleWebSocket(c.req.raw, {
    roomName: `subject:${user.tenantScopedId}:rooms:${c.req.param('room')}`,
    installationId: readInstallationId(c.req.raw),
  });
});
```

The enterprise app keeps its IAM, database, audit policy, and SSO model. Epicenter sync does not import those concepts.

## Terms

```txt
token =
  network credential used by a host route
  short-lived when possible
  does not decrypt workspace data

RelayAccess =
  optional host-level result saying this request may open a subject + room
  not required by SyncEngine if the host builds roomName directly

keyring =
  versioned encryption material used to open encrypted local workspace data
  cached for offline use
  never sent as WebSocket auth

workspace encryption key =
  derived from keyring + workspaceId
  encrypts CRDT values
  not a token and not a room credential

passphrase =
  human input used to unlock or prove possession
  may mint access in solo self-host mode
  should not be passed through the sync protocol as raw auth

roomName =
  internal sync namespace
  should already include subject or tenant scoping before it reaches SyncEngine
```

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Core abstraction | `createSyncEngine` | It removes policy hooks by making the host route the composer. |
| Auth ownership | Host route | Better Auth, enterprise IAM, and self-host secrets are host concerns. |
| Room access | Resolved before engine call | The engine receives `roomName`, not sessions or users. |
| Metering | Return values, not hooks | The host can record usage after engine calls. |
| Deletion | Explicit engine method | Hosts call `deleteRoom` from their own admin routes. |
| Token verifier | Not in v1 engine | Token verification belongs to the host route unless we build a separate relay process. |
| Room boundary | One Yjs doc room | A Durable Object per Yjs doc is the clean Cloudflare boundary. |
| Read-only mode | Deferred | Write access is the only v1 sync capability. |

## What This Refuses

```txt
No Better Auth imports in SyncEngine.
No org or team model in SyncEngine.
No grant tables in SyncEngine.
No callback hooks for billing or policy.
No signed relay token issuer in v1.
No read-only collaboration in v1.
No user profile, email, or display name in room runtime.
```

These can be built in host applications or in a later packaged relay. They should not enter the engine.

## Implementation Plan

### Phase 1: Extract Engine Shape From `apps/api`

- [ ] **1.1** Create a sync engine module near the existing room route code.
- [ ] **1.2** Move HTTP sync request handling behind `sync.handleHttpSync(...)`.
- [ ] **1.3** Move WebSocket upgrade forwarding behind `sync.handleWebSocket(...)`.
- [ ] **1.4** Keep `requireOAuthUser` and billing checks in `apps/api/src/app.ts`.
- [ ] **1.5** Return metering data from engine calls instead of adding callbacks.
- [ ] **1.6** Add tests proving auth stays outside the engine.

### Phase 2: Make The Engine Package Boundary Explicit

- [ ] **2.1** Move reusable engine code into a package or internal module with no Better Auth imports.
- [ ] **2.2** Define `SyncRooms` and Cloudflare Durable Object room adapter.
- [ ] **2.3** Add an in-memory or test room adapter.
- [ ] **2.4** Document the host-route pattern.

### Phase 3: Self-Host Host Routes

- [ ] **3.1** Add a minimal solo self-host example with a shared-secret route guard.
- [ ] **3.2** Keep passphrase or shared-secret handling outside the engine.
- [ ] **3.3** Show how a host maps `{ subject, room }` into `roomName`.

### Phase 4: Optional Packaged Relay

- [ ] **4.1** Build a convenience relay server only after the engine boundary is proven.
- [ ] **4.2** Add signed capability tokens only for separate-process relay deployment.
- [ ] **4.3** Keep same-process host composition as the preferred integration.

## Open Questions

1. Should `roomName` stay subject-scoped (`subject:{subject}:rooms:{room}`) or move to workspace-scoped names when workspace IDs become first-class sync namespaces?
2. Should `handleWebSocket` read `installationId` from the URL, headers, or a parsed input supplied by the host route?
3. Should `dispatch` remain part of the sync engine, or should live-device RPC become a separate engine layered beside sync?
4. Should the Cloudflare Durable Object adapter live in `apps/api` first or move directly into a package?
5. Should HTTP sync and WebSocket sync return the same metering shape?

## Working Rule

When a hook appears, ask whether the host route should own the surrounding control flow instead.

```txt
If host owns the decision:
  host route should call the engine

If engine owns the mechanism:
  engine method should return the data the host needs

If both seem true:
  the boundary is probably one layer too high
```
