# Y-Sweet Provider Connection Supervisor

**Date**: 2026-02-12
**Status**: Superseded
**Author**: AI-assisted
**Superseded by**:

- `20260213T000000-fix-disconnect-reconnect-race.md` — The race condition fix (Phase 1 of this spec, simplified)
- `20260213T000100-runtime-server-switching.md` — Runtime server switching (Phases 2–4, marked optional/future)

## Overview

Redesign the `YSweetProvider` class in `packages/y-sweet/` to replace its event-driven reconnection logic with a centralized connection supervisor loop. This makes runtime URL/token switching a first-class operation and fixes a race condition between `disconnect()` and `websocketClose`.

## Motivation

### Current State

The `YSweetProvider` manages a WebSocket connection to a y-sweet server. It receives an `authEndpoint` callback at construction time, which returns a `ClientToken` containing the WebSocket URL and optional auth token:

```typescript
// packages/y-sweet/src/types.ts
type ClientToken = {
	url: string; // Fully-formed WebSocket URL: ws://server:8080/d/docId/ws
	token?: string; // Optional signed auth token (appended as ?token=xxx)
};

// packages/y-sweet/src/provider.ts
type AuthEndpoint = () => Promise<ClientToken>;
```

The provider is constructed with this auth callback sealed in:

```typescript
// packages/y-sweet/src/provider.ts
class YSweetProvider {
  constructor(
    private authEndpoint: AuthEndpoint,  // private, immutable after construction
    _docId: string,
    private doc: Y.Doc,
    extraOptions: Partial<YSweetProviderParams> = {},
  ) { ... }
}
```

Consumers use it through the `ySweetSync` extension:

```typescript
// packages/epicenter/src/extensions/y-sweet-sync.ts
ySweetSync({
	auth: directAuth('http://localhost:8080'),
	persistence: indexeddbPersistence,
});
```

Or directly in the Tauri app:

```typescript
// apps/epicenter/src/lib/yjs/y-sweet-connection.ts
const provider = createYjsProvider(ydoc, workspaceId, async () => ({
	url: `${serverUrl.replace('http', 'ws')}/d/${workspaceId}/ws`,
}));
```

This creates three problems:

1. **No way to switch servers at runtime**: `authEndpoint` is `private` and set once in the constructor. To connect to a different y-sweet server, you'd need to destroy the provider and create a new one — which also tears down awareness state, event listeners, and any in-flight sync.

2. **Race condition between disconnect and reconnect**: Calling `disconnect()` followed by `connect()` doesn't work reliably because `websocketClose` overwrites the OFFLINE status with ERROR and tries to reconnect on its own (see detailed trace below).

3. **Token cache is a leaky public field**: `clientToken` is the only public escape hatch for changing the connection target, but it's an implementation detail — callers must know to null it out before calling `connect()`.

### The disconnect/connect Race (Detailed)

```
Timeline — calling disconnect() then connect() while a retry loop is running:
──────────────────────────────────────────────────────────────────────────────

1. Old connect() loop is running (isConnecting = true)
   Currently awaiting a backoff sleeper

2. You call disconnect()
   → setStatus(STATUS_OFFLINE)           ← correct
   → websocket.close()                   ← triggers websocketClose handler

3. websocketClose fires asynchronously
   → setStatus(STATUS_ERROR)             ← OVERWRITES OFFLINE with ERROR
   → calls connect()                     ← but isConnecting is still true
   → connect() returns early (silently dropped)

4. You call connect() right after disconnect()
   → isConnecting is still true
   → returns early with console.warn     ← YOUR call is also dropped

5. Old sleeper eventually resolves
   → while loop checks: status is ERROR (not OFFLINE!)
   → loop CONTINUES instead of exiting   ← reconnects to OLD server
```

The root cause: `websocketClose` makes reconnection decisions. It sets status and calls `connect()`, competing with the user's explicit lifecycle calls.

### Desired State

Runtime URL/token switching is a single method call. The connection supervisor owns all reconnection logic. WebSocket event handlers only report events — they never make decisions:

```typescript
// Switch to a different server at runtime:
provider.reconnect({
	authEndpoint: () => fetch('/api/token/my-doc').then((r) => r.json()),
});

// Or via the extension layer:
client.extensions.sync.reconnect({
	authEndpoint: directAuth('http://new-server:9090'),
});

// IndexedDB persistence is completely unaffected.
// Same Y.Doc, same guid, same local storage.
```

## Research Findings

### How Y-Sweet Auth Works (Two Modes)

Y-sweet uses a two-tier token architecture. Understanding both modes is critical because the provider must handle both.

**Hosted / Authenticated Mode (production)**:

```
Your Backend                     Y-Sweet Server
────────────                     ──────────────
POST /doc/{docId}/auth
Authorization: {server_token}
  ────────────────────────────►
                                 Signs a ClientToken
                                 (HMAC-SHA256, expires
                                 after validForSeconds)
  ◄────────────────────────────
Returns: { url: "ws://...", token: "eyJhb..." }
```

The URL in `ClientToken` can point to a **different server** than the one that issued the token — y-sweet supports server-managed routing. The token expires, and the provider's existing retry logic handles refresh: after 3 failed connection attempts, it nulls the cached token and re-calls `authEndpoint`.

**Direct / Unauthenticated Mode (local dev)**:

```
Client constructs the URL directly — no server exchange:
{ url: "ws://localhost:8080/d/{docId}/ws" }   // no token field
```

This is what `directAuth()` does. No expiry, no rotation.

**Key finding**: The `authEndpoint` callback is the single point of indirection for both modes. Changing where the provider connects means changing what this callback returns. The provider doesn't need to know which mode it's in.

### Existing Reconnection Patterns in Yjs Ecosystem

| Provider                           | Reconnection Model                                   | URL Switching                  |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------ |
| y-websocket `WebsocketProvider`    | `websocketClose` → auto-reconnect with backoff       | No — URL fixed at construction |
| Hocuspocus `HocuspocusProvider`    | `onClose` → managed retry with configurable strategy | No — destroy and recreate      |
| y-sweet `YSweetProvider` (current) | `websocketClose` → sets ERROR → calls `connect()`    | No — `authEndpoint` is private |

**Key finding**: No major Yjs provider supports runtime URL switching. They all expect destroy-and-recreate. This is fine for most use cases but inadequate for Epicenter's multi-device sync model where users switch between self-hosted servers and cloud.

**Implication**: We need to build this ourselves. The good news is that we own the fork (`packages/y-sweet/`), so we can modify the provider directly.

### Supervisor Loop Pattern

The connection supervisor pattern (used in database drivers, gRPC clients, service meshes) separates **intent** from **mechanism**:

```
User Intent:     desired = 'online' | 'offline'
Supervisor Loop: while desired === 'online': try to connect, retry on failure
Event Handlers:  report socket death to loop — never make decisions
```

This eliminates the entire class of race conditions because there's exactly one place that decides whether to reconnect: the loop's while condition.

## Design Decisions

| Decision                  | Choice                                                   | Rationale                                                                |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| Where to fix the race     | In the provider (`YSweetProvider`)                       | The bug is in the provider's reconnection logic, not the extension layer |
| Connection model          | Supervisor loop with `desired` state + `runId` epoch     | Eliminates races by design; single decision point for reconnection       |
| `authEndpoint` mutability | Add `setAuthEndpoint()` method                           | Allows runtime switching without destroy/recreate                        |
| `reconnect()` API         | Atomic method: optionally swap auth + restart connection | One call instead of disconnect/null/connect dance                        |
| `clientToken` visibility  | Read-only getter (remove public setter)                  | Prevents external mutation of internal cache                             |
| `websocketClose` behavior | Only signal loop; never set status or call `connect()`   | Root cause fix for the race condition                                    |
| Extension layer API       | Pass through `reconnect()` and `setAuthEndpoint()`       | Extension wraps docId into auth callback; otherwise thin delegation      |
| `connect()` idempotency   | Return in-flight promise instead of dropping             | Prevents silent failures                                                 |

## Architecture

### Connection Supervisor Model

```
┌─────────────────────────────────────────────────────────────────────┐
│                     YSweetProvider                                   │
│                                                                     │
│  User-facing API          Internal State          Supervisor Loop   │
│  ────────────────         ──────────────          ───────────────   │
│                                                                     │
│  connect()  ──────►  desired = 'online'  ───►  while desired ===   │
│                      runId++                    'online' &&         │
│                      start loop                 runId === myRunId:  │
│                                                                     │
│  disconnect() ────►  desired = 'offline' ──►     loop exits        │
│                      runId++                                        │
│                      close socket                                   │
│                                                                     │
│  reconnect() ─────►  swap auth (optional)                          │
│                      invalidate token                               │
│                      desired = 'online'  ───►  new loop starts     │
│                      runId++                                        │
│                      close socket                                   │
│                                                                     │
│  setAuthEndpoint() ► replace callback                               │
│                      invalidate token                               │
│                                                                     │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
│                                                                     │
│  websocketClose ──►  resolve socketClosed    (loop decides what     │
│                      promise (that's ALL)      to do next)          │
│                                                                     │
│  websocketError ──►  resolve socketClosed                           │
│                      promise (that's ALL)                           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Supervisor Loop Pseudocode

```typescript
private async runLoop(myRunId: number): Promise<void> {
  while (this.desired === 'online' && this.runId === myRunId) {
    this.setStatus(STATUS_CONNECTING);

    // 1. Get token (calls authEndpoint if cache is null)
    let clientToken: ClientToken;
    try {
      clientToken = await this.ensureClientToken();
    } catch {
      this.setStatus(STATUS_ERROR);
      await this.backoff(myRunId);
      continue;
    }

    // 2. Check if we were cancelled during auth
    if (this.runId !== myRunId) break;

    // 3. Attempt connection
    const connected = await this.attemptToConnect(clientToken);
    if (!connected) {
      this.retries++;
      if (this.retries >= RETRIES_BEFORE_TOKEN_REFRESH) {
        this._clientToken = null;  // force re-auth
        this.retries = 0;
      }
      await this.backoff(myRunId);
      continue;
    }

    // 4. Connected! Wait for socket to close
    this.retries = 0;
    await this.waitForSocketClose();

    // 5. Socket died. Loop continues if still desired.
    //    No status set here — the loop iteration handles it.
  }
}
```

### Extension Layer (Thin Wrapper)

```typescript
// packages/epicenter/src/extensions/y-sweet-sync.ts
return defineExports({
	provider,
	whenSynced,

	/**
	 * Replace the auth source and reconnect.
	 * The docId is automatically bound from the Y.Doc guid.
	 */
	setAuthEndpoint(auth: (docId: string) => Promise<ClientToken>) {
		provider.setAuthEndpoint(() => auth(ydoc.guid));
	},

	/**
	 * Reconnect with current or new auth. Atomic operation.
	 */
	reconnect(opts?: {
		auth?: (docId: string) => Promise<ClientToken>;
		refreshToken?: boolean;
	}) {
		const providerOpts: ReconnectOptions = { refreshToken: opts?.refreshToken };
		if (opts?.auth) {
			providerOpts.authEndpoint = () => opts.auth!(ydoc.guid);
		}
		return provider.reconnect(providerOpts);
	},

	destroy: () => {
		persistenceCleanup?.();
		provider.destroy();
	},
});
```

### Caller Experience

```typescript
// Switch to a different self-hosted server:
client.extensions.sync.reconnect({
	auth: directAuth('http://new-server:9090'),
});

// Switch to cloud auth:
client.extensions.sync.reconnect({
	auth: (docId) => fetch(`/api/token/${docId}`).then((r) => r.json()),
});

// Force token refresh without changing server:
client.extensions.sync.reconnect({ refreshToken: true });

// Or change auth source now, reconnect later:
client.extensions.sync.setAuthEndpoint(directAuth('http://new-server:9090'));
// ... later ...
client.extensions.sync.reconnect();
```

## Implementation Plan

### Phase 1: Fix the Supervisor Loop in `YSweetProvider`

This is the core change — rewrite the connection lifecycle.

- [ ] **1.1** Add `desired: 'online' | 'offline'` and `runId: number` private fields
- [ ] **1.2** Add `connectRun: Promise<void> | null` to track the active loop
- [ ] **1.3** Rewrite `connect()`: set `desired = 'online'`, return existing `connectRun` if active, otherwise start new `runLoop()`
- [ ] **1.4** Rewrite `disconnect()`: set `desired = 'offline'`, bump `runId`, close socket, null `connectRun`
- [ ] **1.5** Remove side effects from `websocketClose`: only resolve a `socketClosed` promise — no `setStatus()`, no `connect()`
- [ ] **1.6** Remove side effects from `websocketError`: same treatment
- [ ] **1.7** Extract `runLoop(myRunId)` as the single reconnection loop with `runId` gating
- [ ] **1.8** Make `connect()` idempotent: return the in-flight `connectRun` promise

### Phase 2: Add `setAuthEndpoint()` and `reconnect()`

- [ ] **2.1** Change `authEndpoint` from `private` to a replaceable private field
- [ ] **2.2** Add `setAuthEndpoint(auth: AuthEndpoint): void` — replaces callback, invalidates cached token
- [ ] **2.3** Add `reconnect(opts?: ReconnectOptions): Promise<void>` — atomic: swap auth (optional) + restart loop
- [ ] **2.4** Make `clientToken` read-only (getter only, remove public setter)
- [ ] **2.5** Add `invalidateClientToken(): void` as an explicit method

### Phase 3: Update `ySweetSync` Extension

- [ ] **3.1** Add `setAuthEndpoint()` to extension exports (wraps docId binding)
- [ ] **3.2** Add `reconnect()` to extension exports (wraps docId binding)
- [ ] **3.3** Verify existing `destroy()` still works with new provider lifecycle

### Phase 4: Update Consumers

- [ ] **4.1** Update `createYSweetConnection` in `apps/epicenter/` if needed
- [ ] **4.2** Update the SvelteKit layout load that uses `createYSweetConnection`
- [ ] **4.3** Verify all existing tests pass

## Edge Cases

### Rapid reconnect() Calls

1. User calls `reconnect()` with server A
2. Before connection completes, calls `reconnect()` with server B
3. First loop sees `runId` mismatch at next check → exits
4. Second loop connects to server B
5. Result: only the latest `reconnect()` wins — no zombie connections

### disconnect() During Token Fetch

1. `runLoop` is awaiting `authEndpoint()` (e.g., slow network fetch)
2. User calls `disconnect()` → bumps `runId`
3. `authEndpoint()` resolves, but loop checks `runId` → mismatch → exits
4. No connection attempt made

### Token Expiry During Active Connection

1. Provider is connected and syncing normally
2. Auth token expires on the server side
3. Server closes the WebSocket
4. `waitForSocketClose()` resolves
5. Loop continues → `ensureClientToken()` returns cached (expired) token
6. Connection fails → after `RETRIES_BEFORE_TOKEN_REFRESH` failures → cache cleared → fresh token fetched
7. This is unchanged from current behavior and works correctly

### destroy() While Loop is Running

1. `destroy()` calls `disconnect()` (sets desired = offline, bumps runId)
2. Also removes event listeners and awareness states
3. Loop exits at next `runId` check
4. No resource leaks

## Open Questions

1. **Should `reconnect()` return a promise that resolves on first sync, or just on loop start?**
   - Resolving on first sync means callers can `await` it to know the switch worked
   - Resolving on loop start means callers get control back faster and subscribe to status events for the rest
   - **Recommendation**: Resolve on first successful sync (STATUS_CONNECTED), with a configurable timeout. This matches the current `connect()` behavior where callers can await it.

2. **Should `setAuthEndpoint()` automatically reconnect?**
   - If yes: simpler API, one call does everything
   - If no: more control, separate "configure" from "act"
   - **Recommendation**: No — keep them separate. `setAuthEndpoint()` configures, `reconnect()` acts. Users who want both can call `reconnect({ authEndpoint: ... })` which does both atomically.

3. **Should we add a `connectionState` reactive signal for Svelte consumers?**
   - The provider currently emits `connection-status` events
   - Svelte components would benefit from a `$state`-based reactive property
   - **Recommendation**: Defer to a follow-up. The event-based API works today. A reactive wrapper can be added in the Svelte layer without changing the provider.

4. **Should `backoff()` be interruptible by `reconnect()`?**
   - Current: backoff uses a `Sleeper` that can be woken by `online` events
   - Proposed: `reconnect()` bumps `runId` and closes socket, but the old loop might be mid-sleep
   - **Recommendation**: Yes — `reconnect()` should wake the sleeper so the old loop exits immediately instead of waiting out the backoff. The `runId` check ensures it exits, but waking the sleeper makes it snappy.

## Success Criteria

- [ ] `disconnect()` followed by `connect()` works reliably — no race condition
- [ ] `reconnect()` switches to a new server URL in a single call
- [ ] `reconnect()` with new `authEndpoint` fetches a fresh token from the new source
- [ ] Rapid `reconnect()` calls don't create zombie connections (only latest wins)
- [ ] `clientToken` is no longer publicly settable
- [ ] `websocketClose` and `websocketError` do not call `connect()` or set `STATUS_ERROR`
- [ ] All existing tests pass without modification
- [ ] IndexedDB persistence is completely unaffected by URL switching (same Y.Doc, same guid)

## References

- `packages/y-sweet/src/provider.ts` — Core provider class (main file being modified)
- `packages/y-sweet/src/types.ts` — `ClientToken` type definition
- `packages/y-sweet/src/sleeper.ts` — Interruptible timeout utility (used in backoff)
- `packages/y-sweet/src/main.ts` — `createYjsProvider` factory function
- `packages/epicenter/src/extensions/y-sweet-sync.ts` — Extension wrapper (Phase 3)
- `packages/epicenter/src/extensions/websocket-sync.ts` — Plain y-websocket extension (reference, not modified)
- `apps/epicenter/src/lib/yjs/y-sweet-connection.ts` — Direct provider usage in Tauri app (Phase 4)
- `apps/epicenter/src/routes/(workspace)/workspaces/static/[id]/+layout.ts` — SvelteKit route using provider (Phase 4)
- `specs/20260211T200000-fork-y-sweet-client.md` — Original fork spec (context for why we own this code)
- `specs/20260121T170000-sync-architecture.md` — Sync architecture (context for multi-server use case)
