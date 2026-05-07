# opensidian and tab-manager adopt createSession

> Two apps still construct their workspace at module top-level via `await waitForAuthState`. Migrate them to the `createSession` factory pattern that fuji, honeycrisp, and zhongwen already use, so every app gates on identity through the same primitive.

**Date**: 2026-05-07
**Status**: Proposed
**Author**: Captures the asymmetry surfaced after the spec-2 cleanup waves; opensidian and tab-manager are the last two apps not on `createSession`.
**Branch**: follow-up to `feat/encrypted-local-workspace-storage`

## One-sentence thesis

```txt
The five apps in this monorepo gate UI on a signed-in identity plus a
workspace handle; one factory (`createSession`) should own that gating
contract for all of them.
```

## Why this draft exists

Spec 2 + post-implementation review consolidated three apps (fuji, honeycrisp, zhongwen) on `createSession`:

```ts
export const session = createSession({ auth, build: (identity) => {...} });
export type FooSignedIn = InferSignedIn<typeof session>;
```

The remaining two apps (opensidian, tab-manager) still use the older shape:

```ts
await session.whenReady;
const auth = createBearerAuth({...});
const signedInState = await waitForAuthState(auth, ...);
if (signedInState.status !== 'signed-in') throw new Error('signed-in required.');
export const opensidian = openOpensidian({ userId: signedInState.identity.user.id, ... });
auth.onStateChange((state) => { /* reload on sign-out / user-switch */ });
```

Two patterns for the same problem. The split exists for historical reasons, not architectural ones.

## What is wrong today

```txt
SMELL                                         WHERE                                    COMPENSATING FOR
─────────────────────────────────             ──────────────────────────────────       ─────────────────────────────
Top-level await blocks module load until      apps/opensidian/src/lib/                "I want a synchronous import
the user is signed-in                          opensidian/client.ts:25-32              that returns a workspace handle."
                                              apps/tab-manager/src/lib/                Loses the session lifecycle
                                              tab-manager/client.ts:19-27              discriminated union.

Two reload-policy primitives                   client.ts auth.onStateChange + manual    No standard place to express
                                               status checks                            "what does signed-in mean"

`signedIn` reload semantics duplicated         opensidian/client.ts and                Same logic written by hand
                                               tab-manager/client.ts                    in each app

Workspace constructed once at module load      `export const opensidian = ...`         Workspace handle outlives the
                                                                                        signed-in scope on paper
```

## One-sentence test

After this spec:

```txt
"In every app, `session.current` is a discriminated union over
auth lifecycle, and the signed-in variant carries the workspace
handle the app needs."
```

## Asymmetric refusals

```txt
Refusal 1: top-level workspace export
  Deletes:
    - export const opensidian = openOpensidian({...})
    - export const tabManager = await openTabManager({...})
    - The blocking `await waitForAuthState(...)` at module load
    - The hand-rolled auth.onStateChange reload logic

  Replaces:
    - export const session = createSession({ auth, build: (identity) => {...} });
    - export type OpensidianSignedIn = InferSignedIn<typeof session>;
    - createSession owns the user-switch reload; consumers narrow via `session.current`.

  User loss: every consumer that does `import { opensidian } from '...'` and
            uses it synchronously must migrate to `getSignedInSession()` (in a
            Svelte component scope) or guard via `session.current.status`.

Refusal 2: tab-manager as a Chrome extension entry shape
  Tab-manager has no SvelteKit `+layout.svelte`. Its entry points are popup,
  sidepanel, background script, options page. Each is a separate Svelte app
  bundle. createSession's provider model wants exactly one `setSignedInSession`
  per render tree.

  Decision required:
    A. Migrate tab-manager: each entry point's root component installs the
       provider. Three to four provider mounts, all reading the same `session`
       module-level singleton. Workable but new pattern.
    B. Refuse: keep tab-manager on its current synchronous shape. Document
       why. Symmetry is broken for a defensible reason (extension ≠ SPA).

  This spec proposes B with a follow-up to revisit if a third extension
  consumer appears, but flags A as the fully-symmetric answer.
```

## What changes per app (proposed)

### apps/opensidian — full migration

```txt
DELETED:
  apps/opensidian/src/lib/opensidian/client.ts
    - top-level await waitForAuthState
    - if (signedInState.status !== 'signed-in') throw
    - export const opensidian = openOpensidian({...})
    - auth.onStateChange reload logic
    - module-level workspaceAiTools

CREATED / MOVED:
  apps/opensidian/src/lib/auth.ts
    - export const auth = createBearerAuth({...})
    - persistedState BearerSession setup

  apps/opensidian/src/lib/session.svelte.ts
    - export const session = createSession({
        auth,
        build: (identity) => {
          const opensidian = openOpensidian({...});
          return { userId, opensidian, [Symbol.dispose]() {...} };
        },
      });
    - export type OpensidianSignedIn = InferSignedIn<typeof session>;
    - export const [getSignedInSession, setSignedInSession] = createContext<...>();

  apps/opensidian/src/lib/components/SignedInSessionProvider.svelte
    - 3-line setContext wrapper (same shape as fuji/zhongwen)

  apps/opensidian/src/routes/+layout.svelte
    - gate on session.current with pending / signed-out / signed-in branches
    - WorkspaceGate inside the signed-in branch
    - SignedInSessionProvider sets the context for descendants

CONSUMERS:
  Audit `import { opensidian } from ...` across apps/opensidian/src.
  Each consumer migrates to `getSignedInSession()` inside Svelte components,
  or `session.current` narrowing for non-component code.

  workspaceAiTools: rebuild inside the build factory (per-mount), exposed
  on signedIn.aiTools. Or expose actions statically and let consumers
  call `actionsToAiTools(opensidian.actions)` per-component if they need
  per-mount tool instances.
```

### apps/tab-manager — proposed: refuse migration, document the asymmetry

```txt
TAB-MANAGER STAYS on current shape:
  - top-level await pattern preserved (Chrome extension idiom)
  - registerDevice fires once after idb.whenLoaded (current behavior)
  - auth.onStateChange reload (current behavior)

ALTERNATIVE (Refusal 2 option A): full migration
  Each entry point installs its own SignedInSessionProvider.
  Three+ provider mounts referencing one module-level `session`.
  Works but no other extension validates the pattern yet.

This spec defaults to refusal; alternative is a follow-up if and only if
a second extension app needs the same shape.
```

## Wave ordering

```txt
Wave 0   Decide tab-manager: refuse (default) or migrate?
         If refuse, this wave is a no-op decision; tab-manager is unchanged.

Wave 1   apps/opensidian/src/lib/session.svelte.ts (new)
         apps/opensidian/src/lib/auth.ts (move auth out of client.ts)
         apps/opensidian/src/lib/components/SignedInSessionProvider.svelte (new)
         Drop top-level await, top-level export, bindAuthWorkspaceScope-replacement.
         Typecheck.

Wave 2   apps/opensidian/src/routes/+layout.svelte
         Gate on session.current; install provider in signed-in branch.

Wave 3   Migrate consumers in apps/opensidian/src that read `opensidian.X`
         to `getSignedInSession().opensidian.X` (component code) or
         narrow via `session.current` (non-component code).
         Audit grep:  grep -rn "from '\$lib/opensidian/client'" apps/opensidian/src

Wave 4   Verify opensidian (rollback point):
         - typecheck (apps/opensidian + svelte-utils)
         - smoke test: cold boot signed-in / signed-out, sign in, sign out,
           different-user switch (full reload), HMR
         - chat conversation flow still works (chat-state.svelte.ts is the
           heaviest opensidian.X consumer)
         - sample data load still works

Wave 5   (optional) Tab-manager full migration if Wave 0 chose option A.
         Otherwise, cleanup pass: ensure tab-manager docs explain the
         intentional asymmetry.

Wave 6   Final audit:
         grep -rn "waitForAuthState" apps/ packages/
         grep -rn "module-level workspace" docs/
         Update workspace-app-layout skill to document one canonical pattern.
```

## Tradeoffs (honest accounting)

**Top-level await goes away.** Apps no longer block module load on auth. Consumers that imported `opensidian` and used it synchronously now hit a discriminated union. This is more honest — the workspace literally doesn't exist when signed-out — but every call site changes.

**Tab-manager refusal is intentional asymmetry.** The Chrome extension has different module-load semantics (multiple entry points, no shared root layout). Migrating it doubles the provider-install sites for one app. Until a second extension exists to test the pattern, the simpler shape wins. Spec acknowledges this.

**Module-level workspaceAiTools.** Tab-manager's `actionsToAiTools(tabManager.actions)` runs at module load today. After migration, tools are rebuilt per-mount or exposed static. Need to verify the AI tool registration works without a workspace handle at module scope.

**HMR semantics.** Today's pattern disposes the workspace on HMR via `import.meta.hot.dispose`. After migration, the createSession factory's HMR hook handles it. Behavior should match.

**registerDevice timing.** Tab-manager's `registerDevice` fires once after IDB load. In the migrated version, it'd run inside the build factory or as a side effect of the provider mount. Same shape, slightly different lifecycle anchor.

## Open questions

### Q1: Does opensidian have an analog to honeycrisp's `state` aggregation?

Honeycrisp folded `createHoneycrispState` (folders + notes + view) into the SignedIn payload. Opensidian's `chat-state.svelte.ts` is the closest analog. Should it move into `buildOpensidianSignedIn` as `signedIn.chatState`, or stay as a per-component state factory?

Default: leave chat state where it is for now; revisit if multiple components need shared chat state.

### Q2: Should tab-manager's RPC contract types still reference the workspace handle?

`apps/tab-manager/src/lib/workspace/rpc-contract.ts` imports `type { tabManager }`. If tab-manager stays on the top-level export, this still works. If tab-manager migrates, the type derives from `session` instead.

### Q3: Is there a way to share the SignedInSessionProvider across apps?

Five copies of the same 3-line component. A generic component in `@epicenter/svelte` would centralize the `// svelte-ignore state_referenced_locally` suppression and the rationale comment. Tradeoff: per-app type narrowing vs one generic component with type parameters.

This spec leaves the decision out of scope but flags it for the workspace-app-layout skill update.

### Q4: What happens to `bindAuthWorkspaceScope` after this spec?

Already deleted in spec 2 cleanup. This spec just removes the last hand-rolled replacements (the `auth.onStateChange` reload blocks in opensidian/tab-manager client.ts).

If tab-manager refuses migration, its `auth.onStateChange` block stays — that's the only remaining hand-rolled lifecycle handler in the monorepo. Document it as intentional.

## Final check (cohesive-clean-breaks)

```txt
Can I explain the new API without saying "or"?
  Mostly. "Every Svelte app gates on createSession; tab-manager (Chrome
  extension) keeps its top-level shape because it has no shared layout."
  The "or" is the deliberate refusal.

Does one layer own each invariant?
  Yes:
    auth                        identity truth (same as today)
    createSession               when the workspace exists; user-switch reload
    per-app session.svelte.ts   what the SignedIn payload contains
    SignedInSessionProvider     scopes the context to the signed-in subtree
    descendants                 read getSignedInSession() once per component

Would a new caller find only one obvious path?
  For SPAs: yes — createSession + InferSignedIn + SignedInSessionProvider.
  For extensions: top-level await pattern, documented as intentional.

Are examples free of compatibility shapes?
  Yes if we commit. No half-migrated state.

Did I delete stale names instead of leaving aliases?
  Yes. The opensidian module-level export is gone; consumers migrate.

Did I move the boundary that caused the smell, or only wrap it?
  Moved. Auth lifecycle goes through createSession for every SPA.

Did I run the asymmetric wins pass before adding another invariant?
  Yes. Refusing tab-manager's migration is the asymmetric refusal: one app's
  exception keeps the other four apps' patterns clean.
```

## References

- `specs/20260506T013348-session-state-replaces-signed-in-component.md` (spec 1: createSession factory)
- `specs/20260506T143000-lazy-identity-reads-from-auth.md` (spec 2: lazy identity)
- `packages/svelte-utils/src/session.svelte.ts` (createSession + InferSignedIn)
- `apps/fuji/src/lib/session.svelte.ts` (canonical SPA pattern)
- `apps/honeycrisp/src/lib/session.svelte.ts` (with state aggregation in payload)
- `apps/zhongwen/src/lib/session.svelte.ts` (minimal SPA pattern)
- `apps/opensidian/src/lib/opensidian/client.ts` (current pre-migration shape)
- `apps/tab-manager/src/lib/tab-manager/client.ts` (current shape; potentially refused)
