# Local passthrough, remote Result envelope

**Status**: proposal
**Supersedes**: `20260422T234500-unified-action-invocation.md` (strict-Result variant)

## The core idea

Actions have **two** type surfaces, not one.

- **Local** (direct in-process call): the action's signature is literally the handler's signature. Sync handler → sync action. Raw value → raw value. Thrown errors throw. Returned `Result` stays a `Result`. Zero ceremony.
- **Remote** (via RPC proxy / websocket): the action's signature is always `(input) => Promise<Result<T, E | ActionFailed>>`. Forced async, forced envelope — because transport demands it.

One definer produces both shapes. Callers pick the contract they need by picking the import: `workspace.actions` (local) vs `remoteClient.actions` (remote proxy).

## Why the earlier unified approach failed

The v1 spec tried to collapse both onto `Promise<Result<T, E | ActionFailed>>`. The migration showed the cost: every local caller had to `await` and destructure `{data, error}` — even for handlers that literally can't fail (`() => tables.posts.getAllValid()`). Most handlers in the codebase genuinely have no error channel. Forcing one on them is ergonomic tax with no safety payoff, because locally you can `try/catch` a throw like any other JS function.

`ActionFailed` exists to solve a wire problem (thrown errors don't cross processes). It doesn't need to exist in the local call graph.

## Types

### Local (what we already have — keep it)

```ts
type ActionHandler<TInput, TOutput> = (
  ...args: TInput extends TSchema ? [input: Static<TInput>] : []
) => TOutput;

// TOutput is WHATEVER the handler returns. No Promise wrap, no Result wrap.
// - () => 5                → TOutput = 5
// - () => Promise<5>       → TOutput = Promise<5>
// - () => Ok(5)            → TOutput = Result<5, never>
// - async () => Ok(5)      → TOutput = Promise<Result<5, never>>
// - () => { throw ... }    → TOutput = never (throws escape naturally)

type Query<TInput, TOutput>    = ActionHandler<TInput, TOutput> & ActionMeta & { type: 'query' };
type Mutation<TInput, TOutput> = ActionHandler<TInput, TOutput> & ActionMeta & { type: 'mutation' };
```

No changes needed — `defineQuery` / `defineMutation` already work this way.

### Remote (the new piece)

```ts
// Unwrap Promise if present; then wrap in Result<_, ActionFailed>,
// merging with any existing Result error channel.
type RemoteReturn<TOutput> =
  TOutput extends Promise<infer Inner> ? RemoteReturn<Inner>
  : TOutput extends Result<infer T, infer E> ? Promise<Result<T, E | ActionFailed>>
  : Promise<Result<TOutput, ActionFailed>>;

type RemoteAction<A extends Action> =
  A extends Action<infer TInput, infer TOutput>
    ? (...args: TInput extends TSchema ? [input: Static<TInput>] : []) => RemoteReturn<TOutput>
    : never;

// Order matters: Action must be checked before Actions, because functions
// with properties structurally satisfy Actions' index signature.
type RemoteActions<A extends Actions> = {
  [K in keyof A]: A[K] extends Action ? RemoteAction<A[K]>
    : A[K] extends Actions ? RemoteActions<A[K]>
    : never;
};
```

### Examples

| Handler                                    | Local signature                  | Remote signature                                   |
| ------------------------------------------ | -------------------------------- | -------------------------------------------------- |
| `() => 5`                                  | `() => 5`                        | `() => Promise<Result<5, ActionFailed>>`           |
| `() => Promise<Note[]>`                    | `() => Promise<Note[]>`          | `() => Promise<Result<Note[], ActionFailed>>`      |
| `() => Ok(5)`                              | `() => Result<5, never>`         | `() => Promise<Result<5, ActionFailed>>`           |
| `() => Result<Tab, BrowserApiFailed>`      | `() => Result<Tab, …>`           | `() => Promise<Result<Tab, BrowserApiFailed \| ActionFailed>>` |
| sync `() => tables.posts.getAllValid()`    | sync                             | `() => Promise<Result<Post[], ActionFailed>>`      |

## Runtime

### Local path

`defineQuery({ handler })` returns a function where the handler IS the callable. Calling it literally calls the handler. Throws, returns, and Promise-ness are all preserved. Nothing to do — this is how it already works.

### Remote path

The RPC client proxy (new file, e.g. `packages/workspace/src/rpc/remote-actions.ts`) produces a `RemoteActions<A>`-typed tree by recursively mirroring the action tree. Each leaf becomes:

```ts
async (input) => {
  try {
    const result = await sendRpc(path, input);   // returns { data, error }
    return result;                                // already a Result
  } catch (cause) {
    return Err(ActionError.ActionFailed({ action: path, cause }));
  }
}
```

Server side (the process that owns the workspace) responds by running the local action and normalizing:

```ts
async function handleRpc(path, input) {
  try {
    const raw = await runLocalAction(path, input);  // local call, could be sync or async
    if (isResult(raw)) return raw;                  // already has error channel
    return Ok(raw);                                 // wrap raw for wire
  } catch (cause) {
    return Err(ActionError.ActionFailed({ action: path, cause }));
  }
}
```

`isResult` detects the `{data, error}` branded shape (e.g. via a `RESULT_BRAND` symbol or the existing `wellcrafted` brand — TBD which). Already-Result handlers get their error union preserved; raw handlers get `Ok`-wrapped server-side so the wire is uniform.

### `dispatchAction` helper + `RpcDispatch` (coupled change)

Today's signatures both assume `{data, error}`:

```ts
// packages/workspace/src/shared/actions.ts
export async function dispatchAction(actions, path, input): Promise<{data, error}>
// packages/workspace/src/document/attach-sync.ts
export type RpcDispatch = (action, input) => Promise<{data, error}>
```

Both relax to `Promise<unknown>`:

```ts
export async function dispatchAction(actions: Actions, path: string, input: unknown): Promise<unknown> {
  const target = resolvePath(actions, path);
  if (!isAction(target)) throw new Error(`Action not found: ${path}`);
  return await target(input as never);  // might be raw, Result, sync, async — caller decides
}

export type RpcDispatch = (action: string, input: unknown) => Promise<unknown>;
```

`attachSync`'s inbound RPC handler (the single caller of `RpcDispatch` on the wire side) is where the normalization lives: call the dispatch, detect `isResult(raw)`, wrap raw in `Ok`, catch throws → `Err(ActionFailed)`. Test `packages/workspace/src/document/attach-sync.test.ts:290-291` (which constructs a fake `dispatch` returning `{data, error}`) updates to return raw or throw.

Caller `apps/tab-manager/src/lib/client.svelte.ts:70` (`dispatch: (action, input) => dispatchAction(actions, action, input)`) needs no change — the relaxed types are compatible.

## Surfaces that change

- **CLI `epicenter run`**: runs locally. If the action returned a `Result`, inspect `{data, error}` and route error → stderr + exit 1. If it returned a raw value, print it and exit 0. If it threw, print the stack + exit 1. No forced wrapping.
- **AI tool bridge**: same detection — if raw, return as-is; if `Result`, throw on `Err`, return `.data` on `Ok`; let throws propagate.
- **WebSocket RPC** (cross-device): always sees the remote envelope on the client side; server normalizes before sending.
- **Scripts & inline callers**: unchanged. They already call actions directly.

## What `ActionFailed` is for

Exactly two things:

1. **RPC transport**: server-side throws (TypeBox validation failure, handler bug, missing action) become a typed error the client can match on.
2. **Client-side transport failure**: socket drop, timeout, serialization error.

Never for in-process use. If a local caller wants to catch handler throws, `try/catch` is the idiom.

## Migration plan (if we accept this)

1. Keep `actions.ts` as it is today. No definer changes.
2. Add `ActionError` / `ActionFailed` types in a new `shared/action-error.ts` — consumed only by RPC code.
3. Write the remote-proxy types and factory (`RemoteActions<A>`, `createRemoteClient`).
4. Update `dispatchAction` to drop the `{data, error}` return-type assumption.
5. Update CLI `run.ts` to detect Result vs raw before printing.
6. Update AI tool bridge to detect Result vs raw.
7. Handlers that genuinely have typed errors (the 2 tab-manager bug-fix cases) switch to returning `Result` — by choice, not by mandate.

Zero touched callers outside of (5), (6), and the two opt-in tab-manager fixes.

## Open questions

- **How to detect a Result at runtime?** Resolved: `isResult` is exported from `wellcrafted/result`. Use it.
- **Should `defineQuery` optionally accept a schema-validated input path?** Orthogonal to this spec — can come later.
