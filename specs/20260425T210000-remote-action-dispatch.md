# Remote action dispatch — calling actions on a peer device

**Date:** 2026-04-25
**Status:** Proposed
**Depends on:** `specs/20260425T200000-actions-passthrough-adr.md` landing first
**Related:** `specs/20260425T000000-device-actions-via-awareness.md` (the original awareness publishing proposal — partially superseded by the API surface here)

## TL;DR

Calling `bob.tabs.close({ tabIds: [123] })` from Alice's device should be type-safe, ergonomic, and not require Alice's runtime to hold Bob's actions tree. Three pieces:

1. **Discovery** — standardize `device` and `offers` keys in awareness state so any app can find peers and see their capabilities.
2. **Transport** — a typed proxy `remoteWorkspace<TActions>({ sync, awareness, target })` that resolves the peer and routes calls via `sync.rpc()`.
3. **Type safety** — the proxy is generic over the target's action tree TYPE; Alice imports the type from the target app's package, no runtime tree needed.

## What exists today

| Piece | Status |
|---|---|
| `sync.rpc(clientId, action, input)` | Implemented end-to-end |
| `RpcActionMap` / `DefaultRpcMap` / `InferRpcMap<A>` | Implemented |
| `createRemoteActions(actions, send)` | Implemented; unit tested; **never wired to `sync.rpc` in any app** |
| `attachAwareness(ydoc, defs)` typed wrapper | Implemented |
| Standardized `device` / `offers` awareness keys | **Not implemented — spec only** |
| `serializeActionManifest(actions)` | **Not implemented** |
| `invoke(ctx, target, method, input)` helper | **Not implemented** |
| Tab-manager publishes `{ deviceId, client }` to awareness | Implemented (ad-hoc, not the `device`/`offers` convention) |
| Fuji / honeycrisp / opensidian publish nothing to awareness | True today |
| CLI `--peer field=value` resolution | Implemented end-to-end via `sync.rpc`; no live-sync E2E test |

The primitives are all there. What's missing is:
- A standard awareness shape so apps can discover each other uniformly
- A typed wrapper that bundles "find peer + send + decode" so call sites are clean
- Wiring `createRemoteActions` (or a successor) against `sync.rpc`

## Today's call path (working but unergonomic)

```ts
// Alice's code
const peers = workspace.awareness.getAll();
let targetClientId: number | null = null;
for (const [clientId, state] of peers) {
  if (state.deviceId === 'bob-nanoid') {
    targetClientId = clientId;
    break;
  }
}
if (targetClientId === null) {
  // peer not online
  return;
}

const result = await workspace.sync.rpc<TabManagerRpc>(
  targetClientId,
  'tabs.close',
  { tabIds: [123] },
);
// result: Result<{ closedCount: number }, RpcError>
```

This works. It just has too many moving parts at every call site.

## Proposed call path

```ts
// shared types — Bob's app exports its actions tree type
import type { TabManagerActions } from '@epicenter/tab-manager';

// Alice's code
const bob = remoteWorkspace<TabManagerActions>({
  sync: workspace.sync,
  awareness: workspace.awareness,
  target: { deviceId: 'bob-nanoid' },
});

const result = await bob.tabs.close({ tabIds: [123] });
// result: Result<{ closedCount }, BrowserApiFailed | RpcError>
```

Same call-site shape as if Bob's actions were local. Type errors flow through. Peer offline and transport errors come back as `RpcError` variants.

## Discovery: standardize the awareness shape

Define a convention in the workspace package:

```ts
// packages/workspace/src/document/standard-awareness.ts
import { type } from 'arktype';

export const standardAwarenessDefs = {
  device: type({
    id: 'string',
    name: 'string',
    'platform?': "'chrome' | 'firefox' | 'tauri' | 'cli' | 'web'",
  }),
  offers: type('Record<string, unknown>'),
};

export type StandardAwarenessDefs = typeof standardAwarenessDefs;
```

Apps that want to be cross-device-callable extend their awareness defs with these:

```ts
// apps/tab-manager/src/lib/client.svelte.ts
const awareness = attachAwareness(ydoc, {
  ...standardAwarenessDefs,
  client: type('"extension" | "desktop" | "cli"'),
});

// at session-applied:
awareness.setLocal({
  device: {
    id: deviceId,
    name: await generateDefaultDeviceName(),
    platform: 'chrome',
  },
  offers: serializeActionManifest(actions),
  client: 'extension',
});
```

Apps can keep their app-specific awareness fields (`client`) alongside the standard ones (`device`, `offers`).

`serializeActionManifest(actions)` produces a JSON-serializable shape (TypeBox schemas, descriptions, types) that peers can render in pickers, AI prompts, CLI completions, etc:

```ts
// already proposed in spec/20260425T000000
export function serializeActionManifest(
  actions: Actions,
): Record<string, { type: 'query' | 'mutation'; input?: TSchema; description?: string; title?: string }> {
  const out: Record<string, { ... }> = {};
  for (const [action, path] of iterateActions(actions)) {
    out[path.join('.')] = {
      type: action.type,
      input: action.input,
      description: action.description,
      title: action.title,
    };
  }
  return out;
}
```

Both pieces (`standardAwarenessDefs`, `serializeActionManifest`) live in `packages/workspace`. Apps opt in by spreading the defs and calling the helper.

## Transport: typed remote proxy via Proxy (not runtime tree walk)

The current `createRemoteActions(actions, send)` walks the local actions tree at runtime to enumerate paths and build leaves. That's fine for in-process tests but awkward for cross-device dispatch — Alice doesn't have Bob's runtime tree, only the type.

Use a JavaScript `Proxy` instead. Type info comes from the generic; runtime intercepts any property access and produces a leaf:

```ts
// packages/workspace/src/rpc/remote-proxy.ts
import { isResult, Ok } from 'wellcrafted/result';
import { RpcError } from '@epicenter/sync';
import type { Actions, RemoteActions } from '../shared/actions';

export type RemoteSend = (path: string, input: unknown) => Promise<unknown>;

export function createRemoteProxy<TActions extends Actions>(
  send: RemoteSend,
  basePath: string[] = [],
): RemoteActions<TActions> {
  return new Proxy(() => {}, {
    get(_target, prop: string) {
      const path = [...basePath, prop];
      return createRemoteProxy(send, path);
    },
    apply(_target, _thisArg, args: unknown[]) {
      const dotPath = basePath.join('.');
      const input = args[0];
      return (async () => {
        try {
          const raw = await send(dotPath, input);
          return isResult(raw) ? raw : Ok(raw);
        } catch (cause) {
          return RpcError.ActionFailed({ action: dotPath, cause });
        }
      })();
    },
  }) as RemoteActions<TActions>;
}
```

Each property access returns a new proxy with the path extended. Each apply (call) routes through `send`. Branches and leaves are the same proxy — calling `bob.tabs` returns a proxy; calling `bob.tabs.close({...})` calls `send('tabs.close', {...})`.

Use sites:

```ts
// instead of createRemoteActions(actions, send) — keep that for use cases
// that need the runtime tree
const remote = createRemoteProxy<TabManagerActions>(send);
await remote.tabs.close({ tabIds: [123] });   // Promise<Result<{closedCount}, ...>>
```

Generic-only typing. No runtime tree. Works across packages.

The existing `createRemoteActions(actions, send)` can stay for callers that already have the actions tree on hand (mostly tests). Both factories produce the same `RemoteActions<A>` shape.

## Bundling: `remoteWorkspace<TActions>({sync, awareness, target})`

Wraps peer resolution + proxy creation:

```ts
// packages/workspace/src/rpc/remote-workspace.ts
import type { Actions } from '../shared/actions';
import type { Awareness } from '../document/attach-awareness';
import type { SyncAttachment } from '../document/attach-sync';
import type { StandardAwarenessDefs } from '../document/standard-awareness';
import { createRemoteProxy } from './remote-proxy';

export type RemoteTarget =
  | { clientId: number }
  | { deviceId: string }
  | { has: string };  // matches any peer offering this action path

export function remoteWorkspace<TActions extends Actions>({
  sync,
  awareness,
  target,
}: {
  sync: SyncAttachment;
  awareness: Awareness<StandardAwarenessDefs & Record<string, unknown>>;
  target: RemoteTarget;
}): RemoteActions<TActions> {
  return createRemoteProxy<TActions>(async (path, input) => {
    const clientId = resolvePeer(awareness, target, path);
    if (clientId === null) {
      return RpcError.PeerOffline({
        target: targetDescription(target),
        action: path,
      });
    }
    return sync.rpc(clientId, path, input);
  });
}

function resolvePeer(
  awareness: Awareness<StandardAwarenessDefs & Record<string, unknown>>,
  target: RemoteTarget,
  actionPath: string,
): number | null {
  if ('clientId' in target) return target.clientId;
  for (const [clientId, state] of awareness.getAll()) {
    if ('deviceId' in target && state.device?.id === target.deviceId) {
      return clientId;
    }
    if ('has' in target) {
      const offers = state.offers as Record<string, unknown> | undefined;
      if (offers && actionPath in offers) return clientId;
    }
  }
  return null;
}
```

Three target modes:

- `{ clientId: 12345 }` — direct, when the caller already has a clientId.
- `{ deviceId: 'bob-nanoid' }` — name-based, durable across sessions.
- `{ has: 'tabs.close' }` — capability-based, "any peer that offers this action." Useful for "open this in some browser, doesn't matter which."

## Type safety: where do the action types come from?

Three workable patterns, in order of complexity:

### Pattern 1: same app, both ends

Tab-manager extension on Alice's browser calls tab-manager extension on Bob's browser. Both are the same code; the `TabManagerActions` type is in scope on both sides.

```ts
// apps/tab-manager/src/lib/workspace/actions.ts
export function createTabManagerActions(...) { return { ... }; }
export type TabManagerActions = ReturnType<typeof createTabManagerActions>;

// at any call site in the same app:
import type { TabManagerActions } from './workspace/actions';
const bob = remoteWorkspace<TabManagerActions>({ ... });
```

This covers the common case: cross-device dispatch within a single app's deployment.

### Pattern 2: cross-app type re-export

Opensidian wants to call tab-manager. Tab-manager re-exports its action type from a public entry:

```ts
// apps/tab-manager/src/index.ts
export type { TabManagerActions } from './lib/workspace/actions';
```

Opensidian imports it:

```ts
import type { TabManagerActions } from '@epicenter/tab-manager';
const tabManager = remoteWorkspace<TabManagerActions>({ ... });
```

Works as long as the cross-app dependency is reasonable (tab-manager already has a public entry; opensidian importing types is type-only and doesn't pull in browser-specific code).

### Pattern 3: dynamic / discovered at runtime

For genuinely opaque cross-app dispatch (CLI calling whatever device is available, no compile-time knowledge of the action shape), there's no static type. Fall back to:

```ts
const remote = createRemoteProxy<DefaultRpcMap>(send);
const result = await remote['tabs.close']({ tabIds: [123] });
// result: Result<unknown, RpcError>
```

Caller handles the `unknown` output explicitly. The awareness `offers` manifest can be read at runtime for discovery (which paths are available) and rendered into UI (descriptions, schemas), but TypeScript can't infer types from runtime data.

This is the case the CLI handles today via `--peer field=value`; nothing changes for it.

## Concrete call-site comparison

### Before (today)

```ts
// Alice wants to close a tab on Bob
const peers = workspace.awareness.getAll();
let targetClientId: number | null = null;
for (const [clientId, state] of peers) {
  if (state.deviceId === 'bob-nanoid') {
    targetClientId = clientId;
    break;
  }
}
if (targetClientId === null) {
  toast.error('Bob is offline');
  return;
}

const result = await workspace.sync.rpc(
  targetClientId,
  'tabs.close',
  { tabIds: [123] },
);
// result: Result<unknown, RpcError>  ← unknown output type without explicit TMap

if (result.error) {
  toast.error(extractErrorMessage(result.error));
  return;
}
const { closedCount } = result.data as { closedCount: number };
// runtime cast; not type-safe
```

### After

```ts
import type { TabManagerActions } from '@epicenter/tab-manager';

const bob = remoteWorkspace<TabManagerActions>({
  sync: workspace.sync,
  awareness: workspace.awareness,
  target: { deviceId: 'bob-nanoid' },
});

const result = await bob.tabs.close({ tabIds: [123] });
// result: Result<{ closedCount: number }, BrowserApiFailed | RpcError>

if (result.error) {
  toast.error(extractErrorMessage(result.error));
  return;
}
const { closedCount } = result.data;
// fully type-safe
```

### Calling local actions for comparison (post-passthrough)

```ts
// Same call site shape via the typed remote proxy:
const result = await bob.tabs.close({ tabIds: [123] });

// Calling locally (passthrough — handler explicit Result):
const result = await workspace.actions.tabs.close({ tabIds: [123] });
// same Result<{closedCount}, BrowserApiFailed> shape, no RpcError union
```

The only difference between the local and remote call site is the receiver and the error union widening by `RpcError`. The `RemoteActions<A>` mapped type makes this delta explicit.

## Implementation phases

### Phase R1 — Standard awareness convention

- Add `packages/workspace/src/document/standard-awareness.ts` with `standardAwarenessDefs` and `StandardAwarenessDefs` type.
- Export from workspace barrel.
- Add `serializeActionManifest(actions)` to `packages/workspace/src/shared/actions.ts`.

### Phase R2 — Remote proxy

- Add `packages/workspace/src/rpc/remote-proxy.ts` with `createRemoteProxy<TActions>(send)`.
- Tests: equivalent to existing `remote-actions.test.ts` but using the proxy form.
- Keep `createRemoteActions(actions, send)` as a sibling for callers that have the runtime tree.

### Phase R3 — Remote workspace bundle

- Add `packages/workspace/src/rpc/remote-workspace.ts` with `remoteWorkspace<TActions>({ sync, awareness, target })`.
- Tests: with mock awareness state and FakeWebSocket, verify that `{ deviceId }` and `{ has }` resolution work and that `clientId === null` produces `Err(PeerOffline)`.

### Phase R4 — App adoption

- Tab-manager publishes `device` and `offers` to awareness (in addition to existing `deviceId`/`client` for back-compat during transition).
- Tab-manager exports `TabManagerActions` type from its public entry.
- One real call site in tab-manager extension that uses `remoteWorkspace<TabManagerActions>` to demonstrate end-to-end. Likely the cross-device "send tab to my desktop" flow.

### Phase R5 — CLI

- CLI `epicenter run --peer deviceId=X path '{json}'` already works via direct `sync.rpc`. Optionally migrate to use `remoteWorkspace` internally for the typed-error benefits.

## What this enables

1. **Cross-device action dispatch with type safety.** UI components on Alice's device call actions on Bob's as easily as local actions.
2. **AI agents calling tools on other devices.** TanStack AI tools already wrap actions via `actionsToAiTools`; the same wrapping over `remoteWorkspace<TActions>(...)` produces an AI tool that runs on a remote peer transparently.
3. **CLI cross-device dispatch.** `epicenter run desktop-1.tabs.close` could resolve `desktop-1` against awareness and route via `remoteWorkspace`.
4. **Discovery UI.** Read `awareness.getAll()`, show a picker with each peer's `device.name` + a list of `offers` paths, render schema-driven input forms for arbitrary action invocation.

## Open questions

**Capability-based targeting (`{ has: 'path' }`)** — picks the first match in `awareness.getAll()` order. Order isn't deterministic. Fine for most "any peer that can do X" cases; not fine if multiple peers offer the same action and the choice matters. For now: document the non-determinism; if it bites, add `{ hasAll: [...] }` or per-peer routing.

**Versioning** — `offers` doesn't include version info. If Alice and Bob run different versions of the same action, the call may succeed or fail unpredictably. Add `version` to the offer record? Defer until we hit it.

**Authorization** — any peer in the room can call any offered action. Same as today's `sync.rpc`. The room boundary IS the auth boundary. If finer-grained auth becomes needed, the `dispatch` callback can wrap with checks (the spec's "auth gate, audit log, rate limit" use case).

**Discovery freshness** — awareness state can be stale during a peer flicker. Resolution is best-effort at call time. Callers see `PeerOffline` if the resolution misses; retry-on-reconnect is the caller's responsibility today.

## Cross-references

- `specs/20260425T200000-actions-passthrough-adr.md` — the action-shape decision this design depends on.
- `specs/20260425T000000-device-actions-via-awareness.md` — the original awareness publishing proposal. This doc supersedes its `invoke()` helper proposal in favor of the `remoteWorkspace<TActions>` typed proxy form, but reuses `serializeActionManifest` and the `device`/`offers` awareness convention verbatim.
- `packages/cli/src/util/find-peer.ts` — existing peer resolution implementation; pattern is generalizable into `resolvePeer`.
