# Execution prompt — Phase 1: `attachSync` API revision

> **Status note (2026-04-25):** This phase landed (commits `fd3a1ce8d` through `88ef425b1`). The "always-async, always-Result" design in § Change 5 has since been **superseded** by `specs/20260425T200000-actions-passthrough-adr.md`. The dispatch+getToken changes (Changes 1, 2, 4), the `ACTION_BRAND` removal (Change 3), and the deletion of `RemoteReturn`/`RemoteAction` types stand. Only the framework-side `defineMutation`/`defineQuery` async/Result wrap is being reverted; the type deletions remain correct.

**For an implementer with no prior conversation context.** Self-contained brief.

**Branch**: create a fresh branch off `main`. Suggested name: `attach-sync-dispatch-revision`.

---

## What you're doing

Revise `attachSync`'s public API to fix three smells in the current shape. Ship as a single PR. All consumers are in this repo or on the same migration cadence — clean break, no compat shims.

The full architecture context lives in two specs:
- `specs/20260424T180000-drop-document-factory-attach-everything.md` (post-factory architecture, action shape)
- `specs/20260425T000000-device-actions-via-awareness.md` (per-device discovery layer)

**Read both before starting.** This prompt is the execution slice; the specs are the why.

---

## The five changes

### Change 1 — `dispatch:` callback for incoming RPC

**Today**: incoming RPC dispatch is wired post-construction via `sync.serveRpc(actions)` (or similar two-step pattern). Sync is half-configured between the two calls; forgetting the second call silently breaks RPC.

**After**: `attachSync` accepts a `dispatch:` option at construction:

```ts
const sync = attachSync(ydoc, {
  url: '...',
  waitFor: persistence.whenLoaded,
  dispatch: (method, input) => dispatchAction(actions, method, input),
});
```

Sync calls `dispatch` on each incoming RPC. `dispatch` returns `Promise<Result<T, E>>` (per Change 4). Sync sends the Result back over the wire.

**Why callback, not data**: `dispatch: (m, i) => Promise<Result<...>>` keeps sync ignorant of action shapes. Custom dispatch (auth gate, audit log, rate limit) wraps the line. `serve: Actions` was considered and rejected — see teardown spec design decisions.

### Change 2 — `getToken:` callback for token sourcing

**Today**: playground configs use a fire-and-forget IIFE:

```ts
void (async () => {
  const loaded = await sessions.load(SERVER_URL);
  sync.setToken(loaded?.accessToken ?? null);
  sync.reconnect();
})();
```

Latent race: sync may attempt to connect before the IIFE resolves. First connect is unauthenticated; if the IIFE throws, no one knows.

**After**: `attachSync` accepts a `getToken:` callback. Sync calls it when it needs a token (initial connect, reconnect, refresh).

```ts
const sync = attachSync(ydoc, {
  url: '...',
  waitFor: persistence.whenLoaded,
  getToken: async () => (await sessions.load(SERVER_URL))?.accessToken ?? null,
  dispatch: (method, input) => dispatchAction(actions, method, input),
});
```

The `void (async () => { ... })()` block disappears from playground configs.

In the SPA, `getToken: () => auth.getToken()` replaces the `setToken` calls inside `auth.onSessionChange`. The session-change block keeps `encryption.applyKeys` and `sync.reconnect()` calls, but no token plumbing.

### Change 3 — Drop `ACTION_BRAND`

**Today**: `defineQuery`/`defineMutation` stamp `ACTION_BRAND` (a `Symbol.for`-keyed marker) on returned callables. `iterateActions(handle)` walks bundles looking for branded callables.

**After**: drop the brand symbol entirely. `isAction(v)` becomes a structural check:

```ts
export function isAction(v: unknown): v is Action {
  return typeof v === 'function'
      && v !== null
      && 'type' in v
      && (v.type === 'query' || v.type === 'mutation');
}
```

Same for `isQuery`, `isMutation`. The symbol export goes away.

**Why**: the brand existed to detect actions in arbitrary mixed bundles. With actions in their own dedicated registry (created via `createFujiActions(tables)`), every entry is an action by construction. The brand is paying for a problem we no longer have.

**Verify before deleting**: grep for `ACTION_BRAND` across all packages. If anything outside `packages/workspace/src/shared/actions.ts` uses it (cross-package detection), keep the brand and update the spec instead. The expectation is no external consumers.

### Change 4 — Drop `requiresToken` option; infer from `getToken`

**Today**: `attachSync` has both `requiresToken: boolean` and (after change 2) `getToken?: () => Promise<string | null>`. These are redundant — providing `getToken` IS the declaration that the connection requires tokens. Keeping both creates an inconsistency surface (what if `requiresToken: true` but `getToken` is missing?).

**After**: drop `requiresToken` entirely. Sync infers from `getToken` presence:

```ts
// authenticated connection
attachSync(ydoc, { url, waitFor, getToken: async () => '...' });

// unauthenticated connection
attachSync(ydoc, { url, waitFor });
```

Internally, sync sets the equivalent of `requiresToken = (typeof opts.getToken === 'function')` once at construction. The branch downstream from `requiresToken` reads the same.

Verify before deleting: grep for `requiresToken` across the repo. Update each call site to drop the field. Existing callers using `requiresToken: true` should already be (or be becoming) consumers of `getToken`; if any case has `requiresToken: true` without a token source, that's a latent bug to flag.

### Change 5 — Always async, always Result; drop `RemoteReturn`

**Today**: action handlers can return raw values, `Result`s, or Promises. Local callers see the handler's signature verbatim. Remote callers see `RemoteReturn<TOutput>` — a conditional type that unwraps Promise, wraps raw in `Ok`, merges `E` with `ActionFailed`. Two semantic worlds.

**After**: every action returns `Promise<Result<T, E>>` from the caller's perspective. Handler-side flexibility preserved via framework normalization:

```ts
type Handler<I, T, E> = (input: I) =>
  | T
  | Result<T, E>
  | Promise<T | Result<T, E>>;

function defineMutation({ handler, ...rest }) {
  return Object.assign(
    async (input) => {
      const result = await handler(input);
      return isResult(result) ? result : Ok(result);
    },
    { type: 'mutation' as const, ...rest },
  );
}
```

`isResult(value)` checks the wellcrafted `Result` brand — accidental Result-shaped data isn't misdetected.

**Delete `RemoteReturn` and `RemoteAction` types.** Remote callers see `Promise<Result<T, E | RpcError | InvokeError>>` — error union widens by transport errors, data type is unchanged.

**Migration of existing Fuji actions**: each handler in `apps/fuji/src/lib/workspace.ts`'s `createFujiActions` returns a raw value today. Add `async` to the handler signature; raw returns auto-wrap. No call-site changes needed in the SPA.

---

## Files to touch

### Add or modify

- `packages/workspace/src/shared/actions.ts` — drop `ACTION_BRAND`, restructure `defineMutation`/`defineQuery` to normalize handlers, remove `RemoteReturn`/`RemoteAction` types, simplify type signatures around `Promise<Result>`.
- `packages/workspace/src/document/attach-sync.ts` (or wherever `attachSync` lives — verify path) — add `dispatch?: (method, input) => Promise<Result<unknown, RpcError>>` and `getToken?: () => Promise<string | null>` to options. Wire `dispatch` into incoming RPC handler. Wire `getToken` into auth flow (call before each connect/reconnect). Remove `serveRpc` method if it exists.
- `apps/fuji/src/lib/workspace.ts` — add `async` to each action handler. No other changes.
- `apps/fuji/src/lib/client.svelte.ts` — replace `setToken` calls in `auth.onSessionChange` with `getToken: () => auth.getToken()` in the `attachSync` options. Remove now-redundant `setToken` calls inside the session-change block.
- `playground/tab-manager-e2e/epicenter.config.ts` — drop the IIFE; use `getToken` and `dispatch` options. Confirm the file still works end-to-end.
- `playground/opensidian-e2e/epicenter.config.ts` — same.

### Verify (grep, don't edit blindly)

- Search for `ACTION_BRAND` anywhere outside `packages/workspace/src/shared/actions.ts`. Expected: zero hits. If any, stop and report.
- Search for `serveRpc` across the repo. Should disappear after this PR.
- Search for `void (async () => {` patterns — confirm the playground IIFEs are gone.
- Search for `setToken` calls — confirm they're gone from session-change handlers.
- Search for `requiresToken` across the repo. Should disappear after this PR.

---

## Test surface

- `bun test packages/workspace` should pass after changes.
- `bun test packages/cli` should pass (CLI dispatch may need touch-ups; coordinate).
- Manual verification: open Fuji SPA in a browser; create / update / delete entries; confirm sync round-trips between two tabs.
- Manual verification: run `bun run playground/tab-manager-e2e/epicenter.config.ts` — confirm it boots cleanly with no IIFE-related warnings or auth race symptoms.

---

## What's NOT in this phase

- No awareness changes (no `device` / `offers` publishing yet — that's phase 2 in the awareness spec).
- No `serializeActionManifest` or `invoke` helpers (phase 1 of awareness spec).
- No CLI dot-prefix dispatch (`desktop-1.action.path`) — that's a later phase coordinating with the CLI scripting-first spec.
- No removal of `createDocumentFactory` / `Document` / `DocumentHandle` — those are bigger phases of the teardown spec.
- No `openFuji()` wrapper removal — separate phase.

This phase is **just the `attachSync` API revision plus action-shape simplification.** Keep the diff focused.

---

## How to know you're done

A self-check the implementer can run before opening a PR:

- [ ] `attachSync(ydoc, { dispatch, getToken })` works against Fuji and both playgrounds.
- [ ] No `serveRpc` method anywhere.
- [ ] No `void (async () => { sync.setToken(...) })()` IIFE in any config.
- [ ] No `ACTION_BRAND` exports remain.
- [ ] No `requiresToken` option on `attachSync`.
- [ ] `RemoteReturn` and `RemoteAction` types are deleted.
- [ ] Every Fuji action handler is `async`.
- [ ] `bun test` passes.
- [ ] `bun run build` passes.
- [ ] Two-tab Fuji edit + sync works end-to-end.

If any item fails, stop and report which one — don't paper over it.

---

## Open coordination questions to flag if hit

These are deliberately deferred but might surface during work:

1. If `attachSync` already has different option names for the equivalent of `dispatch`/`getToken`, **check with the user before renaming.** Use the spec names if there's no conflict; otherwise raise the question.
2. If existing tests rely on `ACTION_BRAND` for assertions, the spec direction is to delete those tests too (the brand is gone). Flag any unexpected dependencies.
3. If a Fuji action handler was previously sync-only and a caller depends on its sync execution (e.g., inside a Y.Doc transaction's microtask boundary), flag it. The `async` change introduces a microtask hop. Most callers won't care, but verify.

---

## Style and process

- Follow the repo's commit conventions (see `.agents/skills/git/`).
- Use `wellcrafted` for any new error types per the codebase's existing patterns (`packages/workspace/src/document/document.ts` is a current reference for `defineErrors` usage).
- Keep the diff focused — no surrounding cleanup, no opportunistic refactors. The teardown spec has its own phases for that.
- Don't add backwards-compat shims. All consumers migrate in this PR.

---

## What this phase enables (so you know when to stop)

After this PR lands, three independent next phases unblock:

1. **Awareness publishing layer** — adds `serializeActionManifest(actions)` and `invoke(ctx, target, method, input)` helpers, updates Fuji + playgrounds to publish `device` + `offers` to awareness. Depends on stable action shape (this phase) so manifest serialization has a known target.
2. **Big teardown** — removes `createDocumentFactory`, `Document`, `DocumentHandle`, `iterateActions`, `ActionIndex`. Drops the `openFuji()` wrapper in favor of top-level inline composition. Larger PR; mostly independent of this one but easier with a stable action shape.
3. **CLI cross-device dispatch** — `epicenter run desktop-1.action.path` resolution via awareness lookup. Depends on phase 2 (awareness publishing must land first).

If you finish phase 1 and feel tempted to start touching `Document` / `DocumentHandle` / `createDocumentFactory` — stop. That's phase 4. The smaller diff here is more reviewable and makes the bigger teardown safer.
