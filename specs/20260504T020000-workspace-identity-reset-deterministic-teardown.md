# Workspace Identity Reset: Deterministic Teardown

**Date**: 2026-05-04
**Status**: Draft
**Author**: AI-assisted (Claude)
**Branch**: codex/sync-create-auth (or successor)
**Sibling spec**: `specs/20260504T010000-drop-redirect-sign-in-gis-migration.md` (per-app GIS migration; ships independently)
**Supersedes**: `specs/20260504T000000-auth-workspace-drop-sync-control.md` (earlier draft scoped only to the syncControl parameter; the deeper teardown invariant turned out to be the load-bearing change)

## One-Sentence Test

Workspace identity reset is a deterministic teardown sequence (destroy the Y.Doc, await sync disposal, clear local data, destroy the JS context); every defensive mechanism in `auth-workspace` and the workspace surface that compensated for the absence of this sequence is removed.

If the design retains a `pause()` call to make sync offline during reset, threads a `SyncControl` parameter through any caller, leaves any reset path with a conditional `reload()`, or keeps `composeSyncControls` alive for hypothetical future fan-out, the design is not clean yet.

## Overview

Today's "sign out and reset" flow is partially deterministic. It depends on `window.location.reload()` to be the real teardown but the reload is conditional inside a try-catch; if `clearLocalData()` throws, the app shows a toast and keeps running with half-cleared local state. This conditional teardown forced layers above (`auth-workspace`) to add defensive sync-pause logic that narrows the in-process race window between auth-change and reload.

This spec replaces the partial teardown with a deterministic one:

```
1. Destroy the Y.Doc           (synchronous; aborts attachSync, detaches listeners)
2. Await sync.whenDisposed     (the WebSocket actually closes)
3. Clear local data
4. Destroy the JS context      (reload, in finally — unconditional)
```

With this teardown in place, every defensive mechanism the layers above accumulated becomes provably redundant and is removed in cascading order: the `syncControl?.pause()` calls, the `syncControl` parameter on `bindAuthWorkspaceScope`, the `composeSyncControls` helper, the `SyncControl` named base type, and the `BrowserWorkspace.syncControl` field.

The result is fewer concepts, less code, and a single layer that owns "what happens when identity transitions to terminal state."

## Why this is the right scope

This is the worked example for `docs/articles/20260504T030000-when-the-smell-wont-die-go-up-a-level.md`: each round of grilling found another defensive surface compensating for the same missing invariant (deterministic teardown), and the final scope is what made all of those surfaces evaporate at once.

The scope evolved through three rounds of grilling. The first iteration proposed only dropping the cold-null pause. The second uncovered factual errors (`composeSyncControls` is already orphaned; `BrowserWorkspace` carries the field; the doc surface was incomplete). The third found three load-bearing issues:

1. **Listener registration order is reversed in earlier traces.** `attachSync` registers `auth.onChange` first (during `openFuji()`), `bindAuthWorkspaceScope` registers second (after the bundle returns and the client wires the binding).
2. **`reload()` is conditional.** Every app's `resetLocalClient` only reloads if `clearLocalData()` succeeds. If it throws, only a toast renders.
3. **The reset-path pause IS doing real work.** It synchronously closes the WS *before* `await clearLocalData()` yields. Without it, there's a microtask-window race where pre-queued WS messages can mutate the doc and trigger IDB writes that race the clear.

These findings collapse into one root cause: there is no deterministic teardown. The pauses and the conditional reload are partial mitigations for that absence.

The cohesive-clean-breaks principle says: move the boundary that caused the smell, don't wrap it. The boundary that needs moving is the reset path itself — make it deterministic, then the mitigations vanish.

## Grounding (DeepWiki, queried 2026-05-04)

**Better Auth.** `signOut()` is auth-only. There is no canonical Better Auth pattern for atomic teardown of local state. The `onSuccess` callback is the recommended hook for clearing local state and reloading. WebSocket session-token revocation is NOT propagated by Better Auth; clients are responsible. Source: `better-auth/better-auth`.

**Yjs.** `ydoc.destroy()` is synchronous and detaches all `on()` listeners via `ObservableV2`. Pending IDB writes are NOT awaited by `destroy()` itself; persistence providers expose `whenSynced` for that wait. Updates received after `destroy()` are silently dropped (listeners detached). Canonical teardown sequence: disconnect sync → await persistence-synced → destroy doc → clear persistence. Source: `yjs/yjs`.

**Codebase already has the primitives.** `attach-sync.ts:879-907` registers a one-shot destroy handler on the Y.Doc:

```ts
ydoc.once('destroy', async () => {
  masterController.abort();              // sync: kills supervisor + WS
  // ...
  await waitForWsClose(ws, 1000, log);
  resolveDisposed();                     // resolves whenDisposed
});
```

`sync.whenDisposed` is exposed on `SyncAttachment` (`attach-sync.ts:163`). So `ydoc.destroy()` followed by `await sync.whenDisposed` is a complete sync teardown today, with no new code needed.

## Motivation

### Current state

`bindAuthWorkspaceScope` in `packages/auth-workspace/src/index.ts`:

```ts
export type AuthWorkspaceScopeOptions = {
  auth: AuthClient;
  syncControl: SyncControl | null;       // ← removed
  applyAuthIdentity(identity: AuthIdentity): void;
  resetLocalClient(): Promise<void>;
};
```

Two pause calls live on identity transitions:

```ts
async function processIdentity(identity: AuthIdentity | null) {
  if (identity === null) {
    if (appliedIdentity === null) {
      syncControl?.pause();              // ← cold null
      return;
    }
    await resetCurrentClient();          // calls pause inside
    return;
  }
  // ...
}

async function resetCurrentClient() {
  syncControl?.pause();                  // ← reset path
  // ...
}
```

Every app's `resetLocalClient` (using fuji as the canonical example):

```ts
async resetLocalClient() {
  try {
    await fuji.clearLocalData();
    window.location.reload();            // conditional on success
  } catch (error) {
    toast.error('Could not clear local data', {
      description: extractErrorMessage(error),
    });
    // no reload — app keeps running in inconsistent state
  }
},
```

The auth subscription wiring in each app is:

```
T=0 sync   createBrowserAuth(...)                     → identity readable
T=1 sync   openFuji({ auth, ... })                    → calls attachSync(...)
                                                       → attachSync registers
                                                         auth.onChange  [LISTENER 1]
T=2 sync   bindAuthWorkspaceScope({ auth, ... })       → registers
                                                         auth.onChange  [LISTENER 2]
```

So when `auth.onChange` fans out, attachSync's listener fires first, bindAuthWorkspaceScope's second.

### What today's teardown actually does (with the corrected order)

```
auth.onChange(null) fires
   ├── [1] attachSync's listener:
   │       queueMicrotask(reconnect)
   └── [2] auth-workspace's listener:
            schedule(null) → drain → processIdentity(null)
            → resetCurrentClient(): syncControl.pause()  ← SYNC: aborts cycle, ws.close()
                                    isTerminal = true
                                    await resetLocalClient()  [yields]
                                       ├── tries: await clearLocalData()
                                       │   ├── if succeeds: reload()
                                       │   └── if throws:   toast()
                                       └── (no finally)

(microtask phase)
   reconnect runs: cycleController already aborted, swap, ensureSupervisor
   new loop sees masterController not aborted, sees no credential, parks at offline
```

The pause's value: synchronously closes the WS before `clearLocalData` yields. Without it, the WS would close one microtask later. Either way, that microtask runs before any macrotask, so pre-queued WS messages still don't deliver — but messages that arrive *during* `clearLocalData`'s IDB-yields could land on a still-living ydoc.

The reload's failure: if `clearLocalData` throws, the app stays alive with sync-paused, IDB partially cleared, ydoc still alive in memory. User sees a toast and keeps working in a corrupted state.

### Desired state

Each app's `resetLocalClient` becomes a deterministic teardown:

```ts
async resetLocalClient() {
  try {
    fuji.ydoc.destroy();              // sync: aborts attachSync masterController
    await fuji.sync.whenDisposed;     // wait for clean WS close
    await fuji.clearLocalData();      // clear IDB
  } catch (error) {
    toast.error('Could not clear local data', {
      description: extractErrorMessage(error),
    });
  } finally {
    window.location.reload();         // unconditional
  }
},
```

The auth-workspace binding's parameter type collapses to:

```ts
export type AuthWorkspaceScopeOptions = {
  auth: AuthClient;
  applyAuthIdentity(identity: AuthIdentity): void;
  resetLocalClient(): Promise<void>;
};
```

`composeSyncControls`, `SyncControl` (the named base type), the `syncControl` field on every `BrowserWorkspace`, and the inline `pause`/`reconnect` shadowing in `SyncAttachment` are all deleted.

## Architecture: the new teardown sequence

```
                 SIGN OUT (or USER SWITCH)
                 ─────────────────────────

  auth.onChange(null) fires (synchronous fan-out from useSession.subscribe)
                 │
                 │ Listeners run in registration order:
                 │
                 ├─[1]─ attachSync's onCredentialChange listener:
                 │      queueMicrotask(reconnect)
                 │      [will run in microtask phase, but...]
                 │
                 └─[2]─ bindAuthWorkspaceScope's listener:
                        schedule(null) → drain → processIdentity(null)
                        → reset(): isTerminal = true
                                   await resetLocalClient()
                                      │
                                      ▼
                          APP'S resetLocalClient RUNS:
                                      │
                                      ▼
                          try {
                            ydoc.destroy()           ← SYNCHRONOUS
                            │  emits 'destroy' event
                            │  ObservableV2 detaches all listeners
                            │  attachSync's destroy handler runs:
                            │    masterController.abort()  ← SYNC
                            │    cycleController also aborts (parent abort)
                            │    onAbort → ws.close() (synchronous)
                            │
                            await sync.whenDisposed   ← WAIT FOR WS CLOSE
                            │  resolves only after waitForWsClose() completes
                            │  WS now CLOSED; no further onmessage possible
                            │
                            await clearLocalData()    ← AWAIT IDB CLEAR
                            │  no race: sync is dead, listeners detached
                            │
                          } catch (error) {
                            toast.error(...)          ← if clear fails
                          } finally {
                            window.location.reload()  ← JS CONTEXT DESTROYED
                          }


                 What happened to the microtask reconnect from [1]?
                 ─────────────────────────────────────────────────

  At the moment ydoc.destroy() runs (synchronously inside resetLocalClient),
  masterController.abort() also runs synchronously. The supervisor's runLoop
  sees signal.aborted and exits. The microtask reconnect, when it eventually
  runs, finds masterController.signal.aborted === true:

    function reconnect() {
      if (masterController.signal.aborted) return;   ← bails here
      // ...
    }

  So the reconnect is a no-op. There is no race. There is no order-dependence
  between the two listeners. ydoc.destroy() makes everything else moot.
```

After `ydoc.destroy()`, every later operation is operating on a dead workspace. Reload at the end is hygiene that handles any throws.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Reset teardown sequence | `ydoc.destroy()` → `await sync.whenDisposed` → `clearLocalData()` → `reload()` in finally | Deterministic; uses primitives already present; reload unconditionally destroys the JS context |
| Reload ownership | App's `resetLocalClient` calls reload directly | Keeps `auth-workspace` runtime-agnostic; matches cohesive-clean-breaks IoC example; visible at the call site |
| `auth-workspace` parameter | Drop `syncControl` | Wave 1 invariant: sync owns its own offline state. After deterministic reset, the pause is provably redundant. |
| Both `pause()` calls | Delete | Cold null was always a no-op; reset-path pause was narrowing a race that no longer exists once `ydoc.destroy()` is the synchronous teardown. |
| `composeSyncControls` | Delete | No source caller. Was a pre-emptive helper that no app adopted. |
| `SyncControl` named base type | Inline `pause`/`reconnect` into `SyncAttachment` and delete | Earned nothing once `composeSyncControls` is gone. The methods stay; the named alias goes. |
| `BrowserWorkspace.syncControl` | Strip the field | No source consumer after the parameter goes. |
| Conditional `reload()` | Move to `finally` | Reload is the real teardown; making it conditional broke the load-bearing invariant. |
| `appliedIdentity: { userId } \| null` | Collapse to `appliedUserId: string \| null` | Wrapping object stored only the userId. |
| `resetCurrentClient` | Rename to `reset` | "current client" naming conflated user identity with workspace lifetime. |
| Failure mode if `clearLocalData` throws | Reload anyway, fresh load shows empty state | Better than today's silent "toast and keep running with half-cleared state." |
| Backwards compatibility | None | Mid-migration; this spec is a clean break. |

## API design

### `auth-workspace`

Before:

```ts
export type AuthWorkspaceScopeOptions = {
  auth: AuthClient;
  syncControl: SyncControl | null;
  applyAuthIdentity(identity: AuthIdentity): void;
  resetLocalClient(): Promise<void>;
};
```

After:

```ts
export type AuthWorkspaceScopeOptions = {
  auth: AuthClient;
  applyAuthIdentity(identity: AuthIdentity): void;
  /**
   * Tear down all local state and destroy the JS context.
   *
   * Recommended sequence:
   *   try {
   *     workspace.ydoc.destroy();
   *     await workspace.sync.whenDisposed;
   *     await workspace.clearLocalData();
   *   } catch (error) {
   *     // optional: toast or log
   *   } finally {
   *     window.location.reload();
   *   }
   *
   * The destruction step (reload, navigate, or otherwise destroying the JS
   * context) MUST be in `finally` so it runs even if cleanup throws. After
   * this resolves, the binding is in a terminal state and ignores further
   * identity changes.
   */
  resetLocalClient(): Promise<void>;
};
```

Internal `reset()` (renamed from `resetCurrentClient`):

```ts
async function reset() {
  isTerminal = true;
  pendingIdentity = undefined;
  try {
    await resetLocalClient();
  } catch {
    // resetLocalClient is contracted to destroy the JS context.
    // We swallow because a thrown clear is a contract violation we
    // can't recover from here. isTerminal already prevents reentry.
  }
}
```

### `attach-sync.ts`

Before:

```ts
export type SyncControl = {
  pause(): void;
  reconnect(): void;
};

export type SyncAttachment = SyncControl & {
  whenConnected: Promise<unknown>;
  // ...
  pause(): void;       // shadows base for JSDoc
  reconnect(): void;   // shadows base for JSDoc
  // ...
};
```

After:

```ts
export type SyncAttachment = {
  whenConnected: Promise<unknown>;
  readonly status: SyncStatus;
  onStatusChange: (listener: (status: SyncStatus) => void) => () => void;
  /** Close the websocket, stop the supervisor, and transition to offline. */
  pause(): void;
  /** Force a fresh connection with new credentials (supervisor restarts iteration). */
  reconnect(): void;
  whenDisposed: Promise<unknown>;
  attachRpc(actions: RpcActionSource): SyncRpcAttachment;
};
```

`SyncControl` removed entirely.

### Workspace bundle (e.g., `apps/fuji/src/lib/fuji/browser.ts`)

Before:

```ts
return {
  ...doc,
  idb,
  entryContentDocs,
  awareness,
  sync,
  syncControl: sync,                  // ← removed
  async clearLocalData() { ... },
  remote,
  rpc,
  whenLoaded: idb.whenLoaded,
  [Symbol.dispose]() { ... },
};
```

After:

```ts
return {
  ...doc,
  idb,
  entryContentDocs,
  awareness,
  sync,
  async clearLocalData() { ... },
  remote,
  rpc,
  whenLoaded: idb.whenLoaded,
  [Symbol.dispose]() { ... },
};
```

`BrowserWorkspace` in `packages/workspace/src/shared/workspace.ts` becomes:

```ts
export type BrowserWorkspace = Workspace & {
  clearLocalData(): Promise<void>;
};
```

## Rejected alternatives

### Option A: binding owns the reload policy

The binding internally wraps `resetLocalClient` in `try/finally` and calls `window.location.reload()` itself.

Rejected because:
1. Couples `auth-workspace` to a browser global, making it harder to use from Tauri webview, headless tests, or future native shells.
2. Hides the reload behind an internal contract; readers of `client.ts` can't see it.
3. Cohesive-clean-breaks skill explicitly cites the inverted version (app owns reload policy) as the IoC example: *"a workspace lifecycle helper may know that signed-out cleanup finished; the app decides whether to reload, show a toast, navigate, or keep running."*

### Drop only the cold-null pause; keep the reset-path pause

Rejected. The reset-path pause is doing real work today (narrows the WS-message race). Keeping it preserves the layer-violation that the cold-null pause exemplifies. Either both go or neither does. The way to make both go is the deterministic teardown.

### Move `pause()` into `attachSync` as a "signed-out" hook

Rejected. `attachSync` already handles signed-out via `openWebSocket → null`. The pause was doing synchronous-ordering work, not signed-out work. Once `ydoc.destroy()` provides the synchronous abort, no hook is needed.

### Keep `composeSyncControls` for "future fan-out"

Rejected. *"Compatibility is a feature. If nobody explicitly asked for that feature, do not smuggle it into the implementation."* No app adopted it; it has no caller; deleting is correct.

### Defer renames (`appliedIdentity`, `resetCurrentClient`)

Rejected after grill 3. The test file already changes substantially in this spec; deferring leaves variable names mismatched between implementation and helpers. Folding in saves a confused mid-state.

### Two specs (separate teardown spec + syncControl spec)

Rejected. The teardown change is the precondition for the syncControl removal being correct. Splitting forces an ugly intermediate where teardown is fixed but the now-redundant pauses still ride. One spec, one clean break.

## Implementation plan

Phase ordering: A is the architectural change (no breakage; pauses still run). B is the cleanup that A enables (breaking changes confined to one wave). C is internal hygiene. D is doc sweep.

Each phase is one or more commits. Within a phase, the bullets are ordered so each commit compiles.

### Phase A: Deterministic teardown (no breakage)

For each app whose `client.ts` has a `resetLocalClient` body:

- [ ] **A.1** Rewrite `resetLocalClient` per the canonical shape:

  ```ts
  async resetLocalClient() {
    try {
      <workspace>.ydoc.destroy();
      await <workspace>.sync.whenDisposed;     // omit for zhongwen (no sync)
      await <workspace>.clearLocalData();
    } catch (error) {
      toast.error('Could not clear local data', {
        description: extractErrorMessage(error),
      });
    } finally {
      window.location.reload();
    }
  },
  ```

  Apps to update:
  - `apps/fuji/src/lib/fuji/client.ts`
  - `apps/honeycrisp/src/lib/honeycrisp/client.ts`
  - `apps/opensidian/src/lib/opensidian/client.ts`
  - `apps/zhongwen/src/lib/zhongwen/client.ts` (no `await sync.whenDisposed`; zhongwen has no `attachSync`)
  - `apps/tab-manager/src/lib/tab-manager/client.ts`
  - `apps/dashboard/src/lib/.../client.ts` if applicable (verify; dashboard may not use auth-workspace yet)

- [ ] **A.2** After every app updated, run per-app typechecks and the auth-workspace tests. Both should still pass — Phase A is additive in terms of behavior (more thorough teardown) and existing tests don't exercise the failure path.

After Phase A, every app reset is deterministic. The pauses still exist but are now provably redundant (`ydoc.destroy()` happens before any `clearLocalData()` yield, and the existing pause runs before that, so order is `pause → ydoc.destroy → whenDisposed → clearLocalData → reload`).

### Phase B: Drop the syncControl surface

- [ ] **B.1 (one commit)** Drop the parameter and all call sites simultaneously:
  - `packages/auth-workspace/src/index.ts`: remove `syncControl: SyncControl | null` from `AuthWorkspaceScopeOptions`; remove from destructure; remove both `syncControl?.pause()` calls; remove `import type { SyncControl }`.
  - For each app's `client.ts`, remove the `syncControl: ...` line from the `bindAuthWorkspaceScope` call:
    - `apps/fuji/src/lib/fuji/client.ts`
    - `apps/honeycrisp/src/lib/honeycrisp/client.ts`
    - `apps/opensidian/src/lib/opensidian/client.ts`
    - `apps/zhongwen/src/lib/zhongwen/client.ts` (the `syncControl: null` line)
    - `apps/tab-manager/src/lib/tab-manager/client.ts`

- [ ] **B.2 (one commit)** Drop `syncControl` from workspace bundles + strip from `BrowserWorkspace` simultaneously:
  - `apps/fuji/src/lib/fuji/browser.ts`: drop `syncControl: sync` field.
  - `apps/honeycrisp/src/lib/honeycrisp/browser.ts`: drop `syncControl: sync` field.
  - `apps/opensidian/src/lib/opensidian/browser.ts`: drop `syncControl: sync` field.
  - `apps/tab-manager/src/lib/tab-manager/extension.ts`: drop `syncControl: sync` field.
  - (zhongwen has no `syncControl` field in its bundle; verified)
  - `packages/workspace/src/shared/workspace.ts`: strip `syncControl: SyncControl` from `BrowserWorkspace`. Drop `import type { SyncControl }` if it becomes unused.

- [ ] **B.3 (one commit)** Barrel removal must precede file deletion:
  - `packages/workspace/src/index.ts`: remove the `composeSyncControls` re-export.
  - Same commit: remove the `SyncControl` re-export (no remaining external consumer; decision is forced).
  - Same commit: delete `packages/workspace/src/document/sync-control.ts`.
  - Same commit: delete `packages/workspace/src/document/sync-control.test.ts`.

- [ ] **B.4 (one commit)** Inline `pause`/`reconnect` into `SyncAttachment`; delete `SyncControl`:
  - `packages/workspace/src/document/attach-sync.ts:128-131`: delete `export type SyncControl = { pause; reconnect };`.
  - `:133`: change `export type SyncAttachment = SyncControl & { ... }` to `export type SyncAttachment = { ... }`.
  - The shadowing `pause()` and `reconnect()` declarations inside `SyncAttachment` (with their JSDoc) remain as the canonical declarations.

### Phase C: Internal renames

- [ ] **C.1** `packages/auth-workspace/src/index.ts`:
  - Rename `appliedIdentity: { userId } | null` → `appliedUserId: string | null`. Drop the wrapping object; compare directly against `identity.user.id`.
  - Rename `resetCurrentClient` → `reset`.

- [ ] **C.2** `packages/auth-workspace/src/index.test.ts`:
  - The test setup helper no longer constructs a fake `syncControl`; remove that branch from `setup()`. Drop the `syncControl: false` test variant.
  - Update each test's expected `calls` array to remove `'pause'` entries. The six tests asserting `'pause'` are at lines 152, 194, 206, 224, 242, 254 (verify before editing).
  - Rename `cold signedOut pauses sync` → `cold signedOut is a no-op`. Assert `[]`.
  - Drop `cold signedOut with null sync control does not throw` — the parameter is gone.
  - Test variable `appliedIdentities: AuthIdentity[]` is unrelated to the implementation rename (different scope, captures full identities). Leave as-is.

### Phase D: Doc sweep

- [ ] **D.1** `docs/articles/satisfies-lets-go-to-definition-follow-the-value.md`: contains six `syncControl`/`SyncControl` references (lines 10, 12, 29, 67, 158, 163, 168). The example is structural — `BrowserWorkspace` shape demonstrates `satisfies` behavior. Either pick a different field that survives this spec (e.g., the existing `idb` reference in the same article), or update the demo `BrowserWorkspace` type to match the new shape.

- [ ] **D.2** `.agents/skills/auth/SKILL.md`:
  - Line 103 (code example showing `syncControl: workspace.syncControl` inside `bindAuthWorkspaceScope`): drop the line.
  - Line 118 (prose recommending fan-out via `pause()`/`reconnect()` on a small inline object): replace with a one-liner that each `attachSync` is independently auth-aware via `openWebSocket` and `onCredentialChange`; no fan-out is needed.

- [ ] **D.3** `docs/guides/consuming-epicenter-api.md` (~line 127): drop the `syncControl: workspace.sync` example or refresh the surrounding sample.

- [ ] **D.4** `packages/workspace/README.md`: strip `composeSyncControls` and `SyncControl` mentions if any; refresh sample code.

- [ ] **D.5** App READMEs: `apps/fuji/README.md`, `apps/honeycrisp/README.md`. Strip `syncControl` mentions; refresh sample code that shows `bindAuthWorkspaceScope` or workspace bundle shape.

- [ ] **D.6** Run straggler greps below.

## Edge cases

### App-admin "Click to reconnect" button

`packages/svelte-utils/src/account-popover/account-popover.svelte` reads `sync.status` and calls `sync.reconnect()` directly off the `SyncAttachment`. After Phase B.4, `pause()` and `reconnect()` are still declared on `SyncAttachment` (they were always there; this spec only removes the named base type alias `SyncControl`). The popover is unchanged.

### CLI and daemon

`packages/cli/src/commands/up.ts:322` uses `sync.onStatusChange`. `packages/workspace/src/daemon/run-handler.ts:146` reads `sync.status`. Neither uses `SyncControl` or `composeSyncControls`. Unchanged. CLI typecheck remains a canary in verification.

### Whispering

`apps/whispering/` does not bind `auth-workspace` (verified: no `bindAuthWorkspaceScope` import). Out of scope.

### Reset paths that don't reload (future)

If a future caller writes a `resetLocalClient` that doesn't reload — e.g., a Tauri webview using `navigate` or a unit test mocking the destruction step — the contract holds: the function must destroy the JS context or equivalent. The binding is in a terminal state after `reset()` completes, so subsequent identity changes are ignored regardless. JSDoc on `resetLocalClient` documents this.

### `clearLocalData` throws

With the new `finally`, reload always runs. The user sees a brief toast (the catch path still toasts) and a fresh page load. The fresh page sees a half-cleared IDB; encryption can't decrypt (signed out, no keys); app shows empty state. Better than today's silent toast-and-keep-running.

### Concurrent identity changes during reset

After `reset()` sets `isTerminal = true`, the drain loop ignores subsequent identities and the reload runs. If a third identity arrives between `await resetLocalClient()` returning and the reload firing, it's ignored — the binding is terminal and the JS context is about to die.

### `ydoc.destroy()` triggers handlers in the same Y.Doc

Confirmed via DeepWiki: synchronous; sets `isDestroyed = true`; recursively destroys subdocuments; emits `'destroy'`; detaches all listeners via `ObservableV2`. The codebase's `attach-sync.ts:879` registers a `once('destroy', ...)` handler that runs `masterController.abort()` synchronously and then awaits the WS close. `whenDisposed` resolves after that handler completes.

### BroadcastChannel during reset

`attachBroadcastChannel` registers a listener on the Y.Doc. `ydoc.destroy()` detaches it. No further BroadcastChannel events reach the destroyed doc.

### Subdocument lifecycle (Fuji's entry-content docs)

Fuji's bundle has `entryContentDocs` (a `createDisposableCache` of child Y.Docs, each with their own `attachSync`). The bundle's `[Symbol.dispose]` already disposes the cache, which destroys each cached child Y.Doc, which triggers each child's `attachSync` destroy handler.

The reset path runs `ydoc.destroy()` on the parent only; child docs are torn down via the bundle's dispose, which the reload-on-finally path doesn't explicitly call. Verify during implementation that reload destroying the JS context is sufficient teardown for the children (it is — JS context destruction kills all timers, sockets, listeners, and in-memory state).

If strict ordering matters (children torn down before parent IDB clears), Phase A could call `entryContentDocs[Symbol.dispose]()` before `ydoc.destroy()`. Worth considering during implementation; not strictly required because reload is the boundary.

## Success criteria

- [ ] No source file imports `composeSyncControls`.
- [ ] No source file imports `SyncControl` from `@epicenter/workspace`.
- [ ] `bindAuthWorkspaceScope`'s parameter type has no `syncControl` field.
- [ ] `BrowserWorkspace` has no `syncControl` field.
- [ ] `packages/workspace/src/document/sync-control.ts` and its test are deleted.
- [ ] No app's workspace bundle exposes a `syncControl` field.
- [ ] `attach-sync.ts` does not export a named `SyncControl` type.
- [ ] Every app's `resetLocalClient` calls `ydoc.destroy()`, awaits `sync.whenDisposed` where applicable, and reloads in `finally`.
- [ ] `bun test packages/auth-workspace` passes.
- [ ] `bun run --filter @epicenter/auth-workspace typecheck` passes.
- [ ] `bun run --filter @epicenter/workspace typecheck` passes.
- [ ] `bun run --filter @epicenter/cli typecheck` passes.
- [ ] Per-app typechecks pass (see verification commands).
- [ ] Manual sign-out smoke test on each browser app: page reloads, fresh state shown, no console errors related to teardown.

## Files to inspect

```
packages/auth-workspace/src/index.ts                   edit (Phase B.1, C.1)
packages/auth-workspace/src/index.test.ts              edit (Phase C.2)
packages/workspace/src/document/attach-sync.ts         edit (Phase B.4)
packages/workspace/src/document/sync-control.ts        delete (Phase B.3)
packages/workspace/src/document/sync-control.test.ts   delete (Phase B.3)
packages/workspace/src/shared/workspace.ts             edit (Phase B.2)
packages/workspace/src/index.ts                        edit (Phase B.3)
apps/fuji/src/lib/fuji/client.ts                       edit (Phase A, B.1)
apps/fuji/src/lib/fuji/browser.ts                      edit (Phase B.2)
apps/honeycrisp/src/lib/honeycrisp/client.ts           edit (Phase A, B.1)
apps/honeycrisp/src/lib/honeycrisp/browser.ts          edit (Phase B.2)
apps/opensidian/src/lib/opensidian/client.ts           edit (Phase A, B.1)
apps/opensidian/src/lib/opensidian/browser.ts          edit (Phase B.2)
apps/zhongwen/src/lib/zhongwen/client.ts               edit (Phase A, B.1)
                                                        (no sync; teardown is ydoc.destroy + clearLocalData)
apps/tab-manager/src/lib/tab-manager/client.ts         edit (Phase A, B.1)
apps/tab-manager/src/lib/tab-manager/extension.ts      edit (Phase B.2)
apps/dashboard/src/lib/.../client.ts                   verify (does dashboard bind auth-workspace?)
packages/svelte-utils/src/account-popover/
  account-popover.svelte                               verify unchanged
.agents/skills/auth/SKILL.md                           edit (Phase D.2; line 103 + line 118)
packages/workspace/README.md                           edit (Phase D.4)
apps/fuji/README.md                                    edit (Phase D.5)
apps/honeycrisp/README.md                              edit (Phase D.5)
docs/articles/satisfies-lets-go-to-definition-follow-the-value.md   edit (Phase D.1)
docs/guides/consuming-epicenter-api.md                 edit (Phase D.3)
```

## Verification commands

```sh
# Auth-workspace and workspace package
bun test packages/auth-workspace/src/index.test.ts
bun run --filter @epicenter/auth-workspace typecheck
bun run --filter @epicenter/workspace typecheck

# CLI canary (SyncControl barrel removal could ripple)
bun run --filter @epicenter/cli typecheck

# Per-app typechecks. Note: opensidian uses `check` not `typecheck`.
bun run --filter @epicenter/fuji typecheck
bun run --filter @epicenter/honeycrisp typecheck
bun run --filter opensidian check
bun run --filter @epicenter/zhongwen typecheck
bun run --filter @epicenter/tab-manager typecheck
bun run --filter @epicenter/dashboard typecheck    # if dashboard binds auth-workspace

# Manual smoke
# Sign out from each browser app; verify:
#   - page reloads
#   - fresh state shows (empty or signed-out UI)
#   - no console errors from teardown
#   - no "could not clear local data" toast that doesn't reload
```

## Straggler searches

```sh
rg -n "composeSyncControls" apps packages docs -S
rg -n "from '@epicenter/workspace'.*SyncControl" apps packages -S
rg -n "syncControl" apps packages docs -S
rg -n "syncControl\?\.pause\(\)|syncControl\.pause\(\)" apps packages -S
rg -n "BrowserWorkspace" packages apps docs -S
```

After implementation:
- The first should match only historical specs.
- The second should be empty in source.
- The third should match only historical specs (parameter, field, and call sites all gone).
- The fourth should be empty.
- The fifth should match the slimmed `BrowserWorkspace` definition and any remaining callers (verify the type still earns its keep with what's left).
