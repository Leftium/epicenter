# Deployment Collapse: Inline Hosted Billing, Merge Dashboard, Ship Team Reference

**Date**: 2026-05-28
**Status**: Draft
**Owner**: Braden
**Supersedes**: `specs/20260528T054721-omega-deployment-profiles.md`

## One Sentence

Ship two deployables (`apps/api` hosted personal cloud and `apps/team-api` self-hosted team reference) against one shared `packages/server` library, by inlining `packages/billing` and `apps/dashboard` into `apps/api`, pulling billing constants out of `packages/constants`, and superseding the stale `apps/server/README.md`.

## How to read this spec

```txt
Read first:
  One Sentence
  Motivation -> Current State, Problems, Desired State
  The Seam
  Architecture -> After
  Implementation Plan

Read if changing the architecture:
  Design Decisions
  Rejected Alternatives
  Decisions Log

Historical only:
  Supersedes (specs/20260528T054721-omega-deployment-profiles.md)
```

## Overview

Epicenter today has one runnable deployable (`apps/api`, hosted personal cloud) and the architecture for a second (self-hosted team) that exists only as composition primitives in `packages/server`. This spec ships the second deployable as a small reference implementation, and collapses everything that is *hosted-cloud-only* (`packages/billing`, `API_ROUTES.billing`, `apps/dashboard`) into `apps/api` so that the shared packages contain only code that both deployables actually use.

## Motivation

### Current State

Two deployment shapes are designed; only one runs.

```txt
packages/
  server/                  shared library (createServerApp, mount*, personal, team, Room)
  billing/                 hosted-only catalog, AI pricing, DTO contracts
  constants/
    api-routes.ts
      session, room, assets, ai     <- both deployments need these
      billing                       <- hosted-only, leaks into shared
    billing-errors.ts               <- hosted-only, leaks into shared
    identity.ts (OwnerId, TEAM_OWNER_ID)
  auth/, encryption/, sync/, workspace/, ui/, cli/

apps/
  api/                     hosted personal cloud
    src/
      index.ts             personal() composition + mountBillingApi + dashboard fallback
      billing/             policies, routes, service (consumes packages/billing)
    wrangler.jsonc         ASSETS binding points at ../dashboard/build
  dashboard/               SvelteKit UI, built then served by apps/api as static assets
  server/                  legacy folder; README describes a shape that no longer exists
                           in packages/server/src/index.ts
  whispering/, tab-manager/
```

`apps/api/src/index.ts:51-65` composes:

```ts
const ownership = personal();
mountSessionApp(app, { ownership });
mountRoomsApp(app, { ownership });
mountAssetsApp(app, { ownership, policies: [trackAssetStorageWithAutumn] });
mountAiApp(app, { auth: requireBearerUser, policies: [chargeAiCreditsWithAutumn] });
mountBillingApi(app, { auth: requireCookieOrBearerUser });
```

`packages/constants/src/api-routes.ts:86`:

```ts
billing: {
  prefixPattern: '/api/billing/*',
  url: (baseURL, sub) => `${stripTrailing(baseURL)}/api/billing/${sub.replace(/^\/+/, '')}`,
},
```

This creates problems:

1. **`packages/billing` has one consumer that by design will never have two.** Team deployments have no billing surface; that is the architecture, not an oversight. A package with one structural consumer is a folder pretending to be infrastructure.
2. **`API_ROUTES.billing` and `billing-errors.ts` pollute shared client constants.** Every client app (`whispering`, `tab-manager`, future) pulls the billing wire shape and error variants even though only `apps/api` (and its dashboard) ever uses them.
3. **`apps/dashboard` is a deployment-time fiction.** It builds into `../dashboard/build` and gets served by `apps/api`'s Workers Static Assets binding. There is one deploy artifact, in two folders, with two `package.json` files and a two-step build.
4. **`apps/server/README.md` actively lies.** It documents `createAccountsRoutes()` / `createSyncRoutes()` / `createHostDispatch()` shapes that no longer exist in `packages/server/src/index.ts`. A new contributor reading it learns an architecture that was deleted.
5. **The team-mode seam has never been compiled end to end.** `personal()` is exercised by `apps/api`; `team({ isMember })` exists only in tests. No deployable proves the composition. No self-hoster has a starting point.

### Desired State

```txt
apps/
  api/                     hosted personal cloud (Worker + dashboard UI in one folder)
    worker/                Hono Worker source (was apps/api/src/)
      index.ts             personal() composition + billing routes + dashboard fallback
      billing/             was packages/billing + apps/api/src/billing
        catalog.ts
        ai-model-pricing.ts
        contracts.ts
        policies.ts
        routes.ts
        service.ts
        errors.ts          was packages/constants/src/billing-errors.ts
        url.ts             was API_ROUTES.billing
    ui/                    SvelteKit dashboard (was apps/dashboard/)
    wrangler.jsonc         ASSETS binding points at ./ui/build
    autumn.config.ts
  team-api/                self-hosted team reference (~30 lines)
    worker/
      index.ts             team({ isMember }) composition, no billing
    wrangler.jsonc         deployment-owned bindings
    README.md              "copy this, customize, deploy. Community-supported."
  whispering/, tab-manager/

packages/
  server/                  unchanged: shared library, two consumers
  constants/
    api-routes.ts          session, room, assets, ai only (no billing key)
    identity.ts            OwnerId, TEAM_OWNER_ID (unchanged)
    request-guard-errors.ts
  auth/, encryption/, sync/, workspace/, ui/, cli/

# DELETED:
#   packages/billing/                    (moved into apps/api/worker/billing/)
#   apps/dashboard/                      (moved into apps/api/ui/)
#   apps/server/                         (stamped Superseded or deleted)
#   packages/constants/src/billing-errors.ts  (moved into apps/api/worker/billing/errors.ts)
```

## The Seam

The personal-vs-team seam is where the two deployments diverge. Everything to the right of the seam is shared. Everything to the left is deployment-specific.

```txt
                        +-----------------------------+
                        |   packages/server           |
                        |   (the library)             |
                        |                             |
                        |   - createServerApp         |
                        |   - personal()              |
                        |   - team({ isMember })      |
                        |   - mountSessionApp         |
                        |   - mountRoomsApp           |
                        |   - mountAssetsApp          |
                        |   - mountAiApp              |
                        |   - authApp                 |
                        |   - Room (Durable Object)   |
                        +--------+----------+---------+
                                 |          |
                  +--------------+          +--------------+
                  |                                        |
                  v                                        v
+---------------------------------+      +---------------------------------+
| apps/api                        |      | apps/team-api                   |
| (hosted personal cloud)         |      | (self-hosted team reference)    |
|                                 |      |                                 |
| ownership = personal()          |      | ownership = team({ isMember })  |
| + Autumn billing policies       |      | (no billing, no Autumn)         |
| + /api/billing/* routes         |      |                                 |
| + ui/ dashboard                 |      | no ui/                          |
|                                 |      |                                 |
| ENCRYPTION_SECRETS = Epicenter  |      | ENCRYPTION_SECRETS = deployer   |
| Epicenter can decrypt           |      | Epicenter literally cannot      |
|   (search, AI, password reset)  |      |   (functionally zero-knowledge) |
+---------------------------------+      +---------------------------------+
```

Trust boundary differs by *deployment secrets*, not by *library shape*. The library has no opinion on who holds the key.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Build `apps/team-api` now | 2 coherence | Yes, as a reference implementation | Proves the seam compiles in CI; gives self-hosters a concrete start; makes zero-knowledge claim demonstrable. ~30 lines is below the "earns its keep" threshold for maintenance. |
| Team-api positioning | 3 taste | Reference demo, not Epicenter-operated product | No team customers yet. Frame as "copy, customize, deploy. Community-supported." Promote to product later by editing the README, not the code. |
| Merge `apps/dashboard` into `apps/api/ui/` | 2 coherence | Yes | Already one deploy artifact via Workers Static Assets. The folder split is convention. |
| Delete `packages/billing` | 2 coherence | Yes, inline into `apps/api/worker/billing/` | One consumer by design. Architecture guarantees no second consumer (team mode has no billing). |
| Move `API_ROUTES.billing` out of `packages/constants` | 2 coherence | Yes, into `apps/api/worker/billing/url.ts` | Shared constants should contain only what every client uses. Billing is hosted-only. |
| Move `billing-errors.ts` out of `packages/constants` | 2 coherence | Yes, into `apps/api/worker/billing/errors.ts` | Same rationale as URL builder. |
| `apps/server/README.md` | 1 evidence | Delete the folder, or stamp Superseded | Verified: `packages/server/src/index.ts` no longer exports the shapes the README describes. The README is stale. |
| Keep `packages/server` library | 2 coherence | Yes | Two real consumers (`apps/api`, `apps/team-api`) earn the library boundary. |
| Keep `OwnershipRule` / `personal()` / `team()` | 2 coherence | Yes | The seam IS the architecture. Both factories are exercised by deployables. |
| Keep `TEAM_OWNER_ID` literal | 1 evidence | Yes | Verified at `packages/constants/src/identity.ts:25-36`: durable HKDF label, R2 prefix, DO name prefix, IDB prefix. Configurability would not enable multi-tenancy; it would break encryption derivation. |
| Keep `mount*` primitives | 2 coherence | Yes | Two consumers exercise the mount API (auth + ownership + route). The `policies` knob on `mountAssetsApp` / `mountAiApp` has one real caller (`apps/api`); the team reference passes no policies. The mount bundling itself earns its keep on count of two; the policies array remains a single-consumer extension point. |
| Keep "self-hosted = functionally zero-knowledge" | 1 evidence | Yes | True by deployment construction: in `apps/team-api`, `ENCRYPTION_SECRETS` lives in the deployer's env. Epicenter literally cannot decrypt. The README claim is accurate and load-bearing. |
| Rename `apps/api` to `apps/hosted-cloud` | 3 taste | No | Documented as hosted personal cloud in README; rename is churn for no win unless naming actively misleads contributors. |
| Hosted team cloud | Deferred | Defer entirely | Real product demand for hosted org admin, seats, invoices, shared org data does not yet exist. A future spec designs it against real requirements. |
| Non-Cloudflare runtime portability | Deferred | Defer | `createServerApp()` assumes Hyperdrive, R2, KV, DOs. Out of scope. |

### Rejected alternatives

| Candidate | Why rejected |
| --- | --- |
| Delete `packages/server` and inline into `apps/api` | Two real consumers (`apps/api`, `apps/team-api`) earn the library. Inlining would force duplication or re-extraction. |
| Delete `OwnershipRule` (collapse personal/team into a Better Auth middleware in each fork) | The seam is a real product story (zero-knowledge self-hosting); the abstraction earns its keep when both modes ship as deployables. |
| Delete `apps/team-api`, ship docs only | Snippet bitrots silently. CI typecheck on a real folder costs ~5 minutes per refactor; the value is making the seam demonstrable. |
| Keep `packages/billing` and rename to `@epicenter/hosted-billing` | Renaming a package-of-one is process theater. Inlining is cheaper and more honest. |
| Add "Future Hosted Team Cloud" profile to this spec | Designing a third deployment against zero requirements. Deferred to a future spec triggered by real product demand. |
| Three-phase plan ("Phase 3: Billing Isolation" as separate phase) | Billing relocation happens during the structural collapse, not after. One PR, one phase. |

## Architecture

### Before (current)

```txt
                        packages/
                        +-- server/      <----+----+----+--  apps/api (personal mode)
                        +-- billing/     <----+        |
                        +-- constants/   <----+        +--  apps/dashboard (SvelteKit)
                        +-- auth/        <----+        |
                        +-- encryption/  <----+        +--  apps/server (stale README)
                        +-- sync/        <----+
                        +-- workspace/   <----+
                                              <--------+--  apps/whispering, tab-manager
```

### After (target)

```txt
                        packages/
                        +-- server/      <----+----+-----+--  apps/api (HOSTED PERSONAL)
                        +-- constants/   <----+    |     |      worker/
                        +-- auth/        <----+    |     |        index.ts (personal())
                        +-- encryption/  <----+    |     |        billing/  (inlined)
                        +-- sync/        <----+    |     |      ui/         (was dashboard)
                        +-- workspace/   <----+    |     |
                                                   |     +--  apps/team-api (TEAM REFERENCE)
                                                   |            worker/index.ts (team({...}))
                                                   |
                                                   +--------  apps/whispering, tab-manager
                        # GONE: packages/billing, apps/dashboard, apps/server
```

### `apps/api` after collapse

```txt
apps/api/
  worker/
    index.ts              personal() + dashboard fallback + billing route mount
    billing/
      catalog.ts          (was packages/billing/src/catalog.ts)
      ai-model-pricing.ts (was packages/billing/src/ai-model-pricing.ts)
      contracts.ts        (was packages/billing/src/contracts.ts)
      policies.ts         (was apps/api/src/billing/policies.ts)
      routes.ts           (was apps/api/src/billing/routes.ts)
      service.ts          (was apps/api/src/billing/service.ts)
      errors.ts           (was packages/constants/src/billing-errors.ts)
      url.ts              (was API_ROUTES.billing in packages/constants)
    db/                   (was apps/api/src/db/)
    scripts/, better-auth.config.ts, drizzle.config.ts (unchanged)
  ui/                     (was apps/dashboard/)
    src/, static/, svelte.config.js, vite.config.ts, package.json
  wrangler.jsonc          ASSETS binding -> ./ui/build
  autumn.config.ts
  package.json            single deploy target; dev runs both worker + ui
```

### `apps/team-api` (new)

```txt
apps/team-api/
  worker/
    index.ts              ~30 lines; team({ isMember }) composition
  wrangler.jsonc          deployment-owned bindings (no AUTUMN_SECRET_KEY)
  README.md               "Reference implementation. Copy, customize, deploy."
  AGENTS.md               (sibling to README per repo convention)
  CLAUDE.md               (shim importing AGENTS.md)
  package.json            depends on @epicenter/server, @epicenter/constants
```

## What stays, what moves, what dies

### Stays unchanged

```txt
packages/server/*                           (the library, two consumers)
packages/constants/src/identity.ts          (OwnerId, TEAM_OWNER_ID, asOwnerId)
packages/constants/src/request-guard-errors.ts
packages/auth, encryption, sync, workspace, ui, cli
apps/whispering, tab-manager
apps/api/wrangler.jsonc bindings semantics  (the ASSETS path changes, rest stable)
The /api/billing/* wire shape               (clients pinned to current paths)
The /api/owners/:ownerId/* wire shape       (clients pinned to current paths)
The /api/ai/chat wire shape                 (clients pinned to current paths)
The encryption README trust table           (true; load-bearing for self-hosters)
```

### Moves (no behavior change)

```txt
packages/billing/src/catalog.ts          -> apps/api/worker/billing/catalog.ts
packages/billing/src/ai-model-pricing.ts -> apps/api/worker/billing/ai-model-pricing.ts
packages/billing/src/contracts.ts        -> apps/api/worker/billing/contracts.ts

packages/constants/src/billing-errors.ts -> apps/api/worker/billing/errors.ts
packages/constants/src/api-routes.ts
  .billing key                           -> apps/api/worker/billing/url.ts (as BILLING_ROUTES)

apps/api/src/                            -> apps/api/worker/
apps/api/src/billing/autumn-products.ts  -> apps/api/worker/billing/autumn-products.ts
                                            (re-exported by apps/api/autumn.config.ts; the
                                             re-export path updates from
                                             ./src/billing/autumn-products to
                                             ./worker/billing/autumn-products)
apps/api/scripts/dev.ts                  edited in place: `dashboardBuild` path changes
                                            from `../dashboard/build/dashboard` to
                                            `../ui/build/dashboard` (relative to scripts/)
apps/api/wrangler.jsonc                  edited in place: ASSETS `directory` changes from
                                            `../dashboard/build` to `./ui/build` (parent of
                                            the SvelteKit `build/dashboard/` subfolder)
apps/dashboard/*                         -> apps/api/ui/*
  package.json                              renamed `@epicenter/dashboard` -> `@epicenter/api-ui`
                                            (no external consumers; verified via grep)
  svelte.config.js                          unchanged: `paths.base = '/dashboard'` and
                                            `pages: 'build/dashboard'` still produce the
                                            same nested `build/dashboard/` layout the
                                            Worker serves at `/dashboard/*`.
```

### Dies

```txt
packages/billing/             (folder + package.json + tsconfig.json)
apps/dashboard/               (folder; contents moved to apps/api/ui/)
apps/server/                  (folder; README is stale, source is empty/non-deployable)
```

### New

```txt
apps/team-api/                (entire folder, ~6 files)
```

## Call sites: before and after

### `apps/api` Worker entry

**Before** (`apps/api/src/index.ts`):

```ts
import {
  authApp, createServerApp,
  mountAiApp, mountAssetsApp, mountRoomsApp, mountSessionApp,
  personal, Room, requireBearerUser, requireCookieOrBearerUser,
} from '@epicenter/server';
import {
  chargeAiCreditsWithAutumn,
  trackAssetStorageWithAutumn,
} from './billing/policies.js';
import { mountBillingApi } from './billing/routes.js';

const ownership = personal();
const app = createServerApp();
// ... mounts unchanged
```

**After** (`apps/api/worker/index.ts`):

```ts
import {
  authApp, createServerApp,
  mountAiApp, mountAssetsApp, mountRoomsApp, mountSessionApp,
  personal, Room, requireBearerUser, requireCookieOrBearerUser,
} from '@epicenter/server';
import {
  chargeAiCreditsWithAutumn,
  trackAssetStorageWithAutumn,
} from './billing/policies.js';
import { mountBillingApi } from './billing/routes.js';

const ownership = personal();
const app = createServerApp();
// ... mounts unchanged
```

Imports are identical (the billing files are now sibling-folder relative imports, which is exactly what they were before; only the absolute workspace path of the file changes).

### `apps/team-api` Worker entry (new)

```ts
// apps/team-api/worker/index.ts
//
// Reference implementation of an Epicenter self-hosted team deployment.
// Copy this folder, fill in deployment-owned secrets, deploy.
// Community-supported. Not operated by Epicenter.

import {
  authApp, createServerApp,
  mountAiApp, mountAssetsApp, mountRoomsApp, mountSessionApp,
  requireBearerUser, team, Room,
} from '@epicenter/server';

export { Room };

const ALLOWED_EMAILS = (env: { ALLOWED_MEMBER_EMAILS?: string }) =>
  new Set(
    (env.ALLOWED_MEMBER_EMAILS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  );

const ownership = team({
  isMember: (c) => ALLOWED_EMAILS(c.env).has(c.var.user.email),
});

const app = createServerApp();
app.get('/', (c) => c.json({ mode: 'team', runtime: 'cloudflare' }));
app.route('/', authApp);
mountSessionApp(app, { ownership });
mountRoomsApp(app, { ownership });
mountAssetsApp(app, { ownership });                  // no policies array
mountAiApp(app, { auth: requireBearerUser });        // no policies array
export default app;
```

Note the deliberate absences: no `AUTUMN_SECRET_KEY`, no `@epicenter/billing` import, no `/api/billing/*` mount, no `apps/dashboard` dependency. The composition shape *is* the contract.

### `packages/constants/src/api-routes.ts`

**Before** (`packages/constants/src/api-routes.ts:86-90`):

```ts
billing: {
  prefixPattern: '/api/billing/*',
  url: (baseURL: string, sub: string) =>
    `${stripTrailing(baseURL)}/api/billing/${sub.replace(/^\/+/, '')}`,
},
```

**After**: deleted from `API_ROUTES`. The URL builder moves to:

```ts
// apps/api/worker/billing/url.ts
const stripTrailing = (s: string) => s.replace(/\/+$/, '');

export const BILLING_ROUTES = {
  prefixPattern: '/api/billing/*',
  url: (baseURL: string, sub: string) =>
    `${stripTrailing(baseURL)}/api/billing/${sub.replace(/^\/+/, '')}`,
} as const;
```

Consumers of `API_ROUTES.billing` (the dashboard UI, billing routes file) update their imports to point at `./url.ts` (relative) or `apps/api/worker/billing/url.ts` (cross-folder from `apps/api/ui/`).

**Semantic shift to flag**: any client outside `apps/api` that imports `API_ROUTES.billing` from `@epicenter/constants/api-routes` will break. Grep before deleting:

```bash
rg -n "API_ROUTES\.billing" --type ts
```

Expected hits: only inside `apps/api/` (worker + ui).

### `packages/constants/src/billing-errors.ts`

Moves verbatim to `apps/api/worker/billing/errors.ts`. All imports of `@epicenter/constants/billing-errors` rewrite to relative or cross-folder paths inside `apps/api/`.

```bash
rg -n "@epicenter/constants/billing-errors" --type ts
```

Expected hits: only inside `apps/api/`.

### `apps/api/wrangler.jsonc`

**Before**: `ASSETS` binding points at `../dashboard/build` (or similar).

**After**: `ASSETS` binding points at `./ui/build`. Build script is `bun run --cwd ui build && wrangler deploy` (or co-located in one `package.json`).

### `apps/api/package.json`

The `dev:dashboard` script (`"bun run --cwd ../dashboard build && bun scripts/dev.ts"`) collapses to a single `dev` that builds `./ui/` first. The `deploy` script collapses analogously.

## Implementation Plan

Build, Prove, Remove. Old paths stay on disk until the new paths are verified end-to-end; then deletion is one wave.

### Phase 1: Build the new structure

Steps are **strictly ordered** within Phase 1. The grouped commit lands at the end of Phase 1, before any typecheck runs.

- [ ] **1.1** Move `apps/api/src/*` -> `apps/api/worker/*`. Update `apps/api/tsconfig.json` includes, `apps/api/wrangler.jsonc` `main` entry path, and `apps/api/autumn.config.ts` re-export path (`./src/billing/autumn-products` -> `./worker/billing/autumn-products`). Edit `apps/api/scripts/dev.ts:5` `dashboardBuild` path to `../ui/build/dashboard`.
- [ ] **1.2** Move `apps/dashboard/*` -> `apps/api/ui/*`. Rename `apps/api/ui/package.json` `name` field from `@epicenter/dashboard` to `@epicenter/api-ui`. Update `apps/api/wrangler.jsonc` ASSETS `directory` from `../dashboard/build` to `./ui/build` (parent of the SvelteKit `build/dashboard/` subfolder; `paths.base` stays `/dashboard`).
- [ ] **1.3** Move `packages/billing/src/{catalog,ai-model-pricing,contracts}.ts` -> `apps/api/worker/billing/`. Rewrite all `@epicenter/billing` imports inside `apps/api/worker/billing/{policies,routes,service}.ts` (and `autumn-products.ts`) to relative `./catalog.ts` etc.
- [ ] **1.4** Move `packages/constants/src/billing-errors.ts` -> `apps/api/worker/billing/errors.ts`. Rewrite all `@epicenter/constants/billing-errors` imports inside `apps/api/worker/billing/` to relative `./errors.ts`. Drop the `./billing-errors` export from `packages/constants/package.json`.
- [ ] **1.5** Create `apps/api/worker/billing/url.ts` with `BILLING_ROUTES` (the `{ prefixPattern, url }` object verbatim from the old `API_ROUTES.billing`). Rewrite consumers in `apps/api/worker/` and `apps/api/ui/` to import from the new location. **Only after** the rewrite, delete the `billing` key from `packages/constants/src/api-routes.ts`.
- [ ] **1.6** Drop `"@epicenter/billing": "workspace:*"` from `apps/api/package.json` and `apps/api/ui/package.json` (was `apps/dashboard/package.json`).
- [ ] **1.7** Create `apps/team-api/` skeleton: `package.json` (depends on `@epicenter/server`, `@epicenter/constants`, `hono`, `wrangler` devDep), `wrangler.jsonc` with placeholder bindings and required vars, `worker/index.ts` (~30 lines, `team({ isMember })` with `ALLOWED_MEMBER_EMAILS` env var), `README.md` (community-supported framing), sibling `AGENTS.md` + `CLAUDE.md` shim per repo convention.

### Phase 1.5: Commit

- [ ] **1.8** Stage all moved/created/deleted files (Phase 1 + Phase 3 deletes) in one logical group. **Do not run typecheck yet.** Commit message captures the structural change as one atomic unit.
- [ ] **1.9** Phase 3 deletions happen *before* the commit (so the commit is the structural collapse, not a follow-up cleanup). See Phase 3 below.

### Phase 2: Prove (post-commit)

- [ ] **2.1** `bun install` at repo root (workspace resolution stabilizes after `packages/billing/` and `apps/dashboard/` deletion).
- [ ] **2.2** `bun run --cwd apps/api typecheck` passes.
- [ ] **2.3** `bun run --cwd apps/api/ui typecheck` passes.
- [ ] **2.4** `bun run --cwd apps/team-api typecheck` passes.
- [ ] **2.5** `bun run --cwd packages/server typecheck` passes (unchanged).
- [ ] **2.6** `bun test packages/server` passes.
- [ ] **2.7** Run `apps/api` locally; confirm `/`, `/api/session`, `/dashboard`, `/api/billing/overview` all respond correctly.
- [ ] **2.8** Run `apps/team-api` locally (with placeholder secrets); confirm `/`, `/api/session` respond. Confirm `/api/billing/*` returns 404.
- [ ] **2.9** Grep audit:
      ```bash
      rg -n "@epicenter/billing|packages/billing" --type ts
      rg -n "API_ROUTES\.billing" --type ts
      rg -n "@epicenter/constants/billing-errors" --type ts
      rg -n "AUTUMN_SECRET_KEY|autumn-js|@epicenter/billing" apps/team-api
      ```
      Expected: zero hits outside `apps/api/` for the first three; zero hits anywhere for the fourth.

If Phase 2 surfaces issues, fix in follow-up commits on top of the structural commit (do not amend; preserves the clean diff).

### Phase 3: Remove (folded into the Phase 1 commit)

- [ ] **3.1** Delete `packages/billing/` entirely.
- [ ] **3.2** Delete `apps/dashboard/` entirely.
- [ ] **3.3** Delete `apps/server/` entirely. Verified empty of source: contains only `README.md`. No grep, no stamp. Just `rm -rf`.
- [ ] **3.4** Update `apps/api/README.md` to drop generic-hub framing; clarify "hosted personal cloud". Keep the encryption trust table.
- [ ] **3.5** Add a sentence to root `AGENTS.md` documenting the two deployables and the seam.

### Phase 4: Documentation (post-commit, separate commit allowed)

- [ ] **4.1** Write `apps/team-api/README.md`: composition reference, deployment-owned config list, "community-supported" framing, link to `apps/api` as the hosted variant.
- [ ] **4.2** Update `docs/architecture/account-and-document-ownership.md` if it references the deleted folders.
- [ ] **4.3** Update `docs/guides/consuming-epicenter-api.md` to note that `/api/billing/*` is hosted-only.
- [ ] **4.4** Update `docs/encryption.md` if it references the apps/server architecture; keep the trust table.

### The grouped commit

Single logical commit captures Phases 1 + 3 (build + remove). Format:

```txt
refactor(deployment): collapse hosted billing into apps/api, ship apps/team-api reference

- merge apps/dashboard into apps/api/ui (rename pkg to @epicenter/api-ui)
- inline packages/billing into apps/api/worker/billing
- move billing-errors + billing URL builder out of packages/constants
- ship apps/team-api as ~30-line self-hosted team reference
- delete apps/server (stale README only)

Supersedes specs/20260528T054721-omega-deployment-profiles.md.
See specs/20260528T145510-deployment-collapse.md.
```

## Edge Cases

### Workers Static Assets binding rewrite (SvelteKit nested layout)

1. SvelteKit `paths.base = '/dashboard'` plus `pages: 'build/dashboard'` writes the bundle to `build/dashboard/index.html` (nested subfolder).
2. The Worker serves it at `/dashboard/*` via the ASSETS binding fallback in `worker/index.ts`.
3. Wrangler ASSETS `directory` must be the **parent** of the SvelteKit `build/dashboard/` subfolder: `./ui/build` (not `./ui/build/dashboard`). This mirrors the current `../dashboard/build` value.
4. `apps/api/scripts/dev.ts` creates the asset directory before `wrangler dev` runs; update the `dashboardBuild` constant to `../ui/build/dashboard` so the `mkdir -p` matches the SvelteKit output path.
5. Test `bun run dev` and `wrangler deploy --dry-run` before merging.

### Cross-package type re-exports

1. If anything outside `apps/api/` (notably `apps/whispering` or `packages/cli`) imports a type from `@epicenter/billing`, the move breaks them.
2. Grep before the structural delete:
   ```bash
   rg -n "from ['\"]@epicenter/billing" --type ts
   ```
3. Expected: only hits inside `apps/api/`. If hits show up in clients, audit each: most are likely dead, otherwise re-export from a new location or refactor the consumer.

### `apps/team-api` Cloudflare bindings

1. Bindings (KV, R2, Hyperdrive, DOs) require a Cloudflare account to provision.
2. The reference `wrangler.jsonc` should ship with placeholder names (`<your-r2-bucket>`, `<your-kv-namespace>`) and a README block telling the deployer what to fill in.
3. Do not commit a working set of bindings (those belong to a real deployment).

### Better Auth secrets for `apps/team-api`

1. `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OPENAI_API_KEY`, `GEMINI_API_KEY` are deployment-owned.
2. The reference `wrangler.jsonc` documents them as required `[vars]` or secrets; the README explains how to set them.

## Open Questions

1. **Reference vs product framing for `apps/team-api`: how prominent in repo docs?**
   - Options: (a) Mentioned in root README. (b) Mentioned in `AGENTS.md` only. (c) Documented but not surfaced.
   - **Recommendation**: (b) for now. Promote to (a) when a real team deployment exists.

2. **`apps/team-api` in CI?**
   - Should `apps/team-api` be part of CI typecheck/test, or run on demand?
   - **Recommendation**: Yes, in CI typecheck. The whole point is to keep the seam compiling. Cost is ~5s. Defer to a follow-up CI config change.

### Closed during grilling

- ~~Does `apps/server/` contain anything besides the stale README?~~ **Closed**: verified `apps/server/` contains only `README.md`. Phase 3.3 is `rm -rf`.
- ~~Should `apps/api/ui/` be a sibling workspace package or a folder inside `apps/api`?~~ **Closed**: SvelteKit tooling requires a `package.json` in the SvelteKit root. `apps/api/ui/` is a workspace member with its own `package.json` (renamed `@epicenter/dashboard` -> `@epicenter/api-ui`).
- ~~Does `BILLING_ROUTES.url` have non-test callers outside `apps/api`?~~ **Closed**: verified zero hits in `apps/whispering`, `apps/tab-manager`, `packages/cli`. The builder stays defined inside `apps/api/worker/billing/url.ts` for `apps/api/ui/` consumption.
- ~~Does `packages/billing` appear in any root `workspaces` array?~~ **Closed**: workspaces glob is `apps/*` + `packages/*` + `examples/*`. No explicit entry; deletion of `packages/billing/` and `apps/dashboard/` is glob-driven.

## Adjacent Work

- **Hosted team cloud**: Not required now. Will be a separate spec triggered by real product demand for hosted org admin, seats, invoices, and shared org-owned data.
- **Non-Cloudflare runtime portability**: Not required. `createServerApp()` assumes Hyperdrive/R2/KV/DOs; portability is a separate project.
- **Admin UI for `apps/team-api` member list**: Static `ALLOWED_MEMBER_EMAILS` is intentional for the first reference. An admin UI ships when a real deployer asks.
- **Renaming `apps/api`**: Not required. Documented as hosted personal cloud in README. Rename if naming actively misleads contributors.

## Decisions Log

Class 3 keeps (taste under constraints) that future maintainers may revisit:

- **Keep `apps/api` name**: rename is churn for no win.
  Revisit when: a contributor mistakes `apps/api` for the team deployable in PR review.
- **Keep `mount*` primitives**: two real consumers earn the abstraction.
  Revisit when: a third deployment shows the primitives are wrong-shaped, or when one consumer needs a knob the primitives do not expose.
- **`apps/team-api` reference-not-product framing**: keeps maintenance low while making the seam demonstrable.
  Revisit when: a paying customer or strategic deployer asks for support contracts.

## Success Criteria

- [ ] `packages/billing/` does not exist on disk.
- [ ] `apps/dashboard/` does not exist on disk.
- [ ] `apps/server/` does not exist on disk OR `apps/server/README.md` is stamped Superseded.
- [ ] `packages/constants/src/api-routes.ts` does not contain a `billing` key.
- [ ] `packages/constants/src/billing-errors.ts` does not exist.
- [ ] `apps/team-api/worker/index.ts` exists, is ~30 lines, and typechecks.
- [ ] `apps/api/worker/` and `apps/api/ui/` exist as siblings; `apps/api/src/` and `apps/dashboard/` do not.
- [ ] `bun run --cwd apps/api typecheck && bun run --cwd apps/team-api typecheck && bun run --cwd packages/server typecheck` all pass.
- [ ] `bun test packages/server` passes.
- [ ] `apps/api` runs locally and serves `/api/billing/*` and `/dashboard`.
- [ ] `apps/team-api` runs locally and serves `/api/session` but not `/api/billing/*`.
- [ ] `apps/team-api/README.md` documents the "reference, community-supported" framing.
- [ ] `apps/api/README.md` documents the hosted personal cloud framing and keeps the encryption trust table.
- [ ] The structural commit (Phases 1 + 3) lands as one atomic commit; typecheck and Phase 2 fixes land on top in follow-up commits if needed.

Grep audits live in Phase 2 (verification), not Success Criteria, to avoid duplication.

## References

- `specs/20260528T054721-omega-deployment-profiles.md` - Superseded predecessor.
- `apps/api/src/index.ts` - Current hosted-personal composition.
- `apps/api/src/billing/{policies,routes,service}.ts` - Will move into `apps/api/worker/billing/`.
- `packages/server/src/index.ts` - The library boundary that both deployables consume.
- `packages/server/src/ownership.ts` - `personal()` / `team()` factories; unchanged.
- `packages/constants/src/api-routes.ts` - Billing key removed; rest unchanged.
- `packages/constants/src/identity.ts` - `OwnerId`, `TEAM_OWNER_ID`; unchanged.
- `packages/billing/src/{catalog,ai-model-pricing,contracts}.ts` - Move targets.
- `apps/dashboard/` - Move target.
- `apps/server/README.md` - Stale; supersede or delete.
- `apps/api/README.md` - Update to hosted-personal framing.
- `apps/api/wrangler.jsonc` - ASSETS binding path updates.
