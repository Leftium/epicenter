# Fix Disconnect/Reconnect Race in YSweetProvider

**Date**: 2026-02-13
**Status**: Draft
**Author**: AI-assisted
**Supersedes**: Partial — replaces Phase 1 of `20260212T224900-y-sweet-provider-connection-supervisor.md`

## Overview

Fix a race condition in `YSweetProvider` where `websocketClose` overwrites the user's explicit `disconnect()` call, preventing clean disconnect/reconnect cycles. This is a surgical fix to the existing code, not a redesign.

## Motivation

### Current State

When a WebSocket closes (server restart, network blip, token expiry), the `websocketClose` handler unconditionally sets `STATUS_ERROR` and calls `connect()`:

```typescript
// packages/y-sweet/src/provider.ts — current code
private websocketClose(_event: CloseEvent) {
    this.setStatus(STATUS_ERROR);    // always
    this.clearHeartbeat();
    this.clearConnectionTimeout();
    this.connect();                   // always

    awarenessProtocol.removeAwarenessStates(...)
}

private websocketError(_event: Event) {
    this.setStatus(STATUS_ERROR);    // always
    this.clearHeartbeat();
    this.clearConnectionTimeout();
    this.connect();                   // always
}
```

The `connect()` method guards against concurrent calls with a boolean flag:

```typescript
public async connect(): Promise<void> {
    if (this.isConnecting) {
        console.warn('connect() called while a connect loop is already running.');
        return;                    // silently drops the call
    }
    this.isConnecting = true;
    // ... retry loop ...
    this.isConnecting = false;
}
```

And `disconnect()` sets status then closes the socket:

```typescript
public disconnect() {
    this.setStatus(STATUS_OFFLINE);
    if (this.websocket) {
        this.websocket.close();    // triggers websocketClose asynchronously
    }
}
```

This creates a race condition:

```
Timeline — calling disconnect() then connect():
──────────────────────────────────────────────────

1. Old connect() loop is running (isConnecting = true)
   Currently awaiting a backoff sleeper

2. User calls disconnect()
   → setStatus(STATUS_OFFLINE)           ← correct
   → websocket.close()                   ← triggers websocketClose handler

3. websocketClose fires asynchronously
   → setStatus(STATUS_ERROR)             ← OVERWRITES OFFLINE with ERROR
   → calls connect()                     ← but isConnecting is still true
   → connect() returns early (silently)

4. User calls connect() right after disconnect()
   → isConnecting is still true
   → returns early with console.warn     ← user's call is also dropped

5. Old sleeper eventually resolves
   → while loop checks: status is ERROR (not OFFLINE)
   → loop CONTINUES reconnecting         ← reconnects to OLD target
```

The root cause: `websocketClose` makes reconnection decisions. It doesn't check whether the user explicitly disconnected.

### Desired State

- `disconnect()` followed by `connect()` works reliably
- `websocketClose` only auto-reconnects if the user hasn't explicitly disconnected
- An in-flight `connect()` loop can be cancelled by `disconnect()`
- No new public API surface, no consumer changes

## Research Findings

### How Other Providers Handle This

| Provider                        | Guard against reconnect-after-disconnect?                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| y-websocket `WebsocketProvider` | Yes — checks `this.wsconnected` and `this.shouldConnect` before reconnecting in `websocketClose` |
| Hocuspocus `HocuspocusProvider` | Yes — `onClose` checks `this.shouldConnect` flag set by `disconnect()`                           |
| y-sweet `YSweetProvider` (ours) | No — `websocketClose` always reconnects                                                          |

**Key finding**: Every mature Yjs provider uses a "should I reconnect?" guard in the close handler. We're the only one that doesn't. This is a straightforward omission, not an architectural gap.

### What the Existing `isConnecting` Flag Misses

The `isConnecting` boolean serves one purpose: prevent two concurrent connect loops. But it doesn't handle cancellation. When `disconnect()` is called mid-loop, the loop has no way to notice. It's awaiting a sleeper or a WebSocket open, and when that resolves, it checks `this.status` — which `websocketClose` already overwrote to `STATUS_ERROR`.

A generation counter (monotonic integer bumped on disconnect) fixes this: the loop checks "am I still the current generation?" before each retry, and exits if not.

## Design Decisions

| Decision                 | Choice                                                          | Rationale                                                                                                           |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Fix location             | `websocketClose`, `websocketError`, `connect()`, `disconnect()` | All four methods participate in the race                                                                            |
| Cancellation mechanism   | Generation counter (`connectGeneration`)                        | Simpler than AbortController; same pattern as `runId` in supervisor architectures but without the full loop rewrite |
| `clientToken` visibility | Leave as-is                                                     | Making it read-only is cleanup, not a bug fix; can be done separately                                               |
| New public API           | None                                                            | The bug is internal; no consumer-facing changes needed                                                              |

## Architecture

No new abstractions. The fix adds a single private field and adjusts four methods:

```
  disconnect()                  websocketClose()
  ────────────                  ────────────────
  bumps connectGeneration       checks status !== OFFLINE
  sets STATUS_OFFLINE             before setting ERROR
  closes socket                   and calling connect()

  connect()                     websocketError()
  ─────────                     ────────────────
  captures myGeneration         same guard as websocketClose
  checks myGeneration match
  before each retry iteration
```

## Implementation Plan

### Phase 1: Add Generation Counter

- [ ] **1.1** Add `private connectGeneration: number = 0` field to `YSweetProvider`
- [ ] **1.2** In `disconnect()`: bump `this.connectGeneration++` before setting status and closing socket. Also wake the reconnect sleeper so the old loop exits promptly instead of waiting out its backoff.
- [ ] **1.3** In `connect()`: capture `const myGeneration = this.connectGeneration` at the top. Replace the `while` condition to also check `myGeneration === this.connectGeneration`. When the loop exits due to generation mismatch, ensure `isConnecting` is reset.

### Phase 2: Guard WebSocket Event Handlers

- [ ] **2.1** In `websocketClose()`: wrap `setStatus(STATUS_ERROR)` and `this.connect()` in `if (this.status !== STATUS_OFFLINE)` guard
- [ ] **2.2** In `websocketError()`: same guard
- [ ] **2.3** Move `awarenessProtocol.removeAwarenessStates()` outside the guard (awareness cleanup should always happen)

### Phase 3: Verify

- [ ] **3.1** Verify existing tests pass
- [ ] **3.2** Manual test: connect → disconnect → connect should work without zombie reconnections
- [ ] **3.3** Manual test: rapid disconnect/connect cycles don't produce errors

## Edge Cases

### disconnect() While Sleeper Is Active

1. Connect loop is in backoff (awaiting sleeper)
2. User calls `disconnect()` → bumps generation, wakes sleeper
3. Sleeper resolves → loop checks generation → mismatch → exits
4. User calls `connect()` → starts fresh loop with new generation

### disconnect() While Awaiting Token

1. Connect loop is in `ensureClientToken()` (slow network)
2. User calls `disconnect()` → bumps generation
3. Token resolves → loop checks generation → mismatch → exits
4. No connection attempt made

### websocketClose During Normal Operation (No User Action)

1. Server closes WebSocket (restart, timeout, etc.)
2. `websocketClose` fires → status is CONNECTED (not OFFLINE)
3. Guard passes → sets ERROR → calls `connect()` → reconnects
4. Behavior unchanged from current code in the normal case

### destroy() During Connect Loop

1. `destroy()` calls `disconnect()` → bumps generation
2. Loop exits at next generation check
3. `destroy()` continues with awareness cleanup and event listener removal

## Open Questions

1. **Should `connect()` return a promise that resolves when connected, or just when the loop starts?**
   - Current behavior: returns `Promise<void>` that resolves when the loop finishes (either connected or gave up)
   - This is fine for the bug fix. If we want `connect()` to be awaitable for "first successful connection," that's a separate enhancement.
   - **Recommendation**: Don't change the return semantics in this fix.

2. **Should we add a test suite for the provider?**
   - There are currently no unit tests for `YSweetProvider`
   - The race condition is hard to test without mocking WebSocket + timers
   - **Recommendation**: Defer to a follow-up. The fix is small enough to verify manually and through integration testing.

## Success Criteria

- [ ] `disconnect()` followed by `connect()` works reliably — status transitions cleanly from OFFLINE → CONNECTING → CONNECTED
- [ ] `websocketClose` does not overwrite OFFLINE status with ERROR
- [ ] An in-flight connect loop exits promptly when `disconnect()` is called
- [ ] No new public API surface introduced
- [ ] All existing consumers (`y-sweet-sync.ts`, `y-sweet-connection.ts`) work without changes
- [ ] No new dependencies

## References

- `packages/y-sweet/src/provider.ts` — The file being modified (all changes are here)
- `packages/y-sweet/src/sleeper.ts` — Sleeper utility (used in backoff; `wake()` call added in disconnect)
- `packages/epicenter/src/extensions/y-sweet-sync.ts` — Primary consumer (should not need changes)
- `apps/epicenter/src/lib/yjs/y-sweet-connection.ts` — Direct consumer in Tauri app (should not need changes)
- `specs/20260212T224900-y-sweet-provider-connection-supervisor.md` — Original combined spec (this spec replaces Phase 1)
