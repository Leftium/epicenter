# Runtime Server Switching for YSweetProvider

**Date**: 2026-02-13
**Status**: Draft (Optional / Future)
**Author**: AI-assisted
**Depends on**: `20260213T000000-fix-disconnect-reconnect-race.md` (must be implemented first)
**Supersedes**: Partial — replaces Phases 2–4 of `20260212T224900-y-sweet-provider-connection-supervisor.md`

## Overview

Add the ability to switch `YSweetProvider` to a different y-sweet server or auth source at runtime without destroying and recreating the provider. This preserves awareness state, event listeners, and avoids tearing down the Y.Doc.

## Motivation

### Current State

After the race condition fix (see sibling spec), the provider's connection lifecycle is sound. But `authEndpoint` is still private and immutable — set once in the constructor:

```typescript
// packages/y-sweet/src/provider.ts
class YSweetProvider {
    constructor(
        private authEndpoint: AuthEndpoint,  // sealed at construction
        _docId: string,
        private doc: Y.Doc,
        extraOptions: Partial<YSweetProviderParams> = {},
    ) { ... }
}
```

To connect to a different server, you destroy the provider and create a new one. This works, but has costs:

1. **Awareness state resets**: All peer presence data is lost and re-established
2. **Event listeners need re-registration**: Consumers that subscribed to `connection-status` or `local-changes` need to re-wire
3. **In-flight sync interruption**: Any pending sync state is discarded

### When Destroy/Recreate Is Fine (Most Cases)

For the current Epicenter architecture, destroy/recreate is the correct approach in these scenarios:

| Scenario                              | Why destroy/recreate is fine                                   |
| ------------------------------------- | -------------------------------------------------------------- |
| Switching sync modes (local → cloud)  | Y.Doc guid changes (`ws-0` → `org_x:ws-0`) — must be a new doc |
| Switching organizations in cloud mode | Doc ID changes — must be a new doc                             |
| First-time setup of sync              | No existing provider to preserve                               |
| Switching workspaces                  | Different doc entirely                                         |

In all these cases, the Y.Doc identity changes, so there's nothing to preserve on the provider.

### When Runtime Switching Would Help

Runtime switching becomes useful when the Y.Doc stays the same but the server changes:

| Scenario                                      | Why hot-swap helps                        |
| --------------------------------------------- | ----------------------------------------- |
| Server migration (same doc, new host)         | Preserve sync state, no re-sync needed    |
| Failover between redundant servers            | Seamless to the user                      |
| Token refresh to same server with new auth    | Avoid reconnection latency                |
| Self-hosted server address change (same data) | e.g., laptop changes IP on network switch |

These scenarios share a property: same Y.Doc guid, same data, different network endpoint. The provider can keep its awareness state and event wiring, and just point the WebSocket somewhere else.

**Honest assessment**: None of these scenarios are urgent for Epicenter today. This is a "nice to have" that reduces friction in edge cases. The main value is making the provider a better general-purpose library.

## Research Findings

### What Yjs Providers Do

| Provider                | Runtime URL switching? | Pattern                                                                     |
| ----------------------- | ---------------------- | --------------------------------------------------------------------------- |
| y-websocket             | No                     | URL fixed at construction                                                   |
| Hocuspocus              | No                     | Destroy and recreate                                                        |
| y-sweet (ours, current) | No                     | authEndpoint fixed at construction                                          |
| Liveblocks              | Yes                    | Internal — not a Yjs provider pattern, but their SDK handles room switching |

No Yjs provider in the ecosystem supports this. This is new territory.

### Supervisor Loop Pattern

The original combined spec proposed a full supervisor loop (desired state + runId epoch). That pattern is well-suited when:

- Connection targets change frequently
- Multiple concurrent connection attempts must be arbitrated
- The system must converge to a "desired state" declared externally

For our use case (infrequent server switches, single WebSocket, user-initiated), the full supervisor loop is overkill. A simpler approach: make `authEndpoint` replaceable and add a `reconnect()` convenience method that atomically swaps auth + restarts the connection.

## Design Decisions

| Decision                  | Choice                                             | Rationale                                                                   |
| ------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| Approach                  | Replaceable `authEndpoint` + `reconnect()` method  | Simpler than full supervisor; covers the actual use cases                   |
| `authEndpoint` mutability | `setAuthEndpoint()` method (not a public property) | Explicit > implicit; method can invalidate cached token                     |
| `reconnect()` semantics   | Disconnect + optionally swap auth + connect        | Atomic operation; leverages the generation counter from the race fix        |
| `clientToken` visibility  | Read-only getter                                   | Prevent external mutation of cached token                                   |
| Full supervisor loop      | Deferred                                           | Not needed until we have dynamic service discovery or multi-server failover |

## Architecture

### New Provider API Surface

```typescript
class YSweetProvider {
	// Existing (unchanged)
	connect(): Promise<void>;
	disconnect(): void;
	destroy(): void;

	// New
	get clientToken(): ClientToken | null; // read-only (was public field)

	setAuthEndpoint(auth: AuthEndpoint): void;
	// Replaces the auth callback. Invalidates cached token.
	// Does NOT reconnect — call reconnect() or connect() separately.

	reconnect(opts?: {
		authEndpoint?: AuthEndpoint; // optionally swap auth
		refreshToken?: boolean; // force token refresh without changing auth
	}): Promise<void>;
	// Atomic: optionally swap auth + disconnect + connect.
	// Uses generation counter to cleanly cancel any in-flight loop.
}
```

### Extension Layer (Thin Wrapper)

```typescript
// packages/epicenter/src/extensions/y-sweet-sync.ts
// New exports added to the extension:

setAuthEndpoint(auth: (docId: string) => Promise<ClientToken>) {
    provider.setAuthEndpoint(() => auth(ydoc.guid));
}

reconnect(opts?: {
    auth?: (docId: string) => Promise<ClientToken>;
    refreshToken?: boolean;
}) {
    const providerOpts: ReconnectOptions = { refreshToken: opts?.refreshToken };
    if (opts?.auth) {
        providerOpts.authEndpoint = () => opts.auth!(ydoc.guid);
    }
    return provider.reconnect(providerOpts);
}
```

### Caller Experience

```typescript
// Switch to a different self-hosted server:
client.extensions.sync.reconnect({
	auth: directAuth('http://new-server:9090'),
});

// Force token refresh without changing server:
client.extensions.sync.reconnect({ refreshToken: true });

// Change auth source now, reconnect later:
client.extensions.sync.setAuthEndpoint(directAuth('http://new-server:9090'));
// ... later ...
provider.disconnect();
provider.connect();
```

## Implementation Plan

**Prerequisite**: The disconnect/reconnect race fix (`20260213T000000`) must be implemented first. This spec builds on the `connectGeneration` counter introduced there.

### Phase 1: Provider Changes

- [ ] **1.1** Change `clientToken` from public field to private field with read-only getter
- [ ] **1.2** Change `authEndpoint` from `private` constructor param to a replaceable private field
- [ ] **1.3** Add `setAuthEndpoint(auth: AuthEndpoint): void` — replaces callback, sets `this.clientToken = null`
- [ ] **1.4** Add `reconnect(opts?)` method — swaps auth if provided, bumps generation, invalidates token if `refreshToken`, calls `disconnect()` then `connect()`

### Phase 2: Extension Layer

- [ ] **2.1** Add `setAuthEndpoint()` to `ySweetSync` extension exports (wraps docId binding)
- [ ] **2.2** Add `reconnect()` to `ySweetSync` extension exports (wraps docId binding)
- [ ] **2.3** Verify existing `destroy()` still works

### Phase 3: Consumer Updates (If Needed)

- [ ] **3.1** Check if `createYSweetConnection` in `apps/epicenter/` needs updating (likely not — it doesn't use `clientToken` directly)
- [ ] **3.2** Check if any code accesses `provider.clientToken` as a setter (search codebase)

## Edge Cases

### Rapid reconnect() Calls

1. User calls `reconnect()` with server A
2. Before connection completes, calls `reconnect()` with server B
3. First `connect()` loop sees generation mismatch → exits
4. Second loop connects to server B
5. Only the latest `reconnect()` wins — no zombie connections

This works because `reconnect()` bumps the generation counter (from the race fix).

### reconnect() With Same Auth

1. User calls `reconnect()` with no auth argument
2. Existing authEndpoint is kept, token cache is invalidated
3. Provider disconnects and reconnects with a fresh token from the same source
4. Useful for "force refresh" scenarios

### setAuthEndpoint() Without reconnect()

1. User calls `setAuthEndpoint(newAuth)` — provider stores new callback, clears cached token
2. Provider stays connected to current server
3. When the current connection eventually drops (server restart, etc.), the reconnect loop uses the new auth
4. This is "change target lazily" — useful when you know a migration is coming but don't want to interrupt active sync

## Open Questions

1. **Should `reconnect()` resolve when connected, or when the loop starts?**
   - Resolving on connection lets callers `await` to know it worked
   - Resolving on loop start gives control back faster
   - **Recommendation**: Resolve on first successful connection (STATUS_CONNECTED), matching the existing `connect()` promise semantics. Add a timeout option if needed later.

2. **Should `setAuthEndpoint()` auto-reconnect?**
   - Simpler API if yes (one call)
   - More control if no (separate configure and act)
   - **Recommendation**: No. Keep them separate. `reconnect({ authEndpoint })` exists for the "do both" case.

3. **Should we expose a reactive `connectionState` for Svelte consumers?**
   - The provider emits `connection-status` events today
   - A `$state`-based wrapper would be more ergonomic in Svelte 5
   - **Recommendation**: Defer. Build it in the Svelte layer (e.g., a `useProviderStatus(provider)` rune), not in the provider itself. The provider should stay framework-agnostic.

## Success Criteria

- [ ] `reconnect()` switches to a new server URL in a single call
- [ ] `reconnect()` with new `authEndpoint` fetches a fresh token from the new source
- [ ] Rapid `reconnect()` calls don't create zombie connections (only latest wins)
- [ ] `clientToken` is no longer publicly settable
- [ ] `setAuthEndpoint()` invalidates the cached token
- [ ] All existing tests pass without modification
- [ ] Existing consumers work without changes (backwards compatible)

## References

- `packages/y-sweet/src/provider.ts` — Core provider (main file being modified)
- `packages/y-sweet/src/types.ts` — `ClientToken` type
- `packages/epicenter/src/extensions/y-sweet-sync.ts` — Extension wrapper (Phase 2)
- `apps/epicenter/src/lib/yjs/y-sweet-connection.ts` — Direct provider usage in Tauri app
- `specs/20260213T000000-fix-disconnect-reconnect-race.md` — Prerequisite: race condition fix
- `specs/20260212T224900-y-sweet-provider-connection-supervisor.md` — Original combined spec
- `specs/20260121T170000-sync-architecture.md` — Sync architecture (context for multi-server use case)
