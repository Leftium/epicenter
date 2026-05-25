# Centralize `c.json(...)` Error Responses Under `defineErrors`

**Date**: 2026-05-24
**Status**: Draft (greenfield-grilled)
**Author**: AI-assisted (claude@bradenwong.com)
**Branch**: TBD

## Greenfield Refinements

After running the `greenfield-clean-breaks` pass, the spec was refused in three places:

1. **Two-location rule dropped.** Every wire-format error lives in one place: `packages/constants/src/<domain>-errors.ts`. The earlier "constants if a client SDK consumes it, server-local otherwise" rule was current-state thinking, not greenfield. Cost of always-in-constants: one extra 10-line file. Cost of two-location rule: every author decides which side; future SDK consumer forces an import-path break.
2. **`AccessError` / `CsrfError` split refused.** Splitting the two middleware variants into two single-variant namespaces was speculative-future overhead. Keep co-located as `RequestGuardError` per the `defineErrors` 2-5-variants-per-domain guideline.
3. **Build/Prove/Remove waves collapsed into three honest commits.** There's no published API, no durable wire contract, no released SDK to migrate. The 5-wave structure was process gold-plating.

`OAuthError` move into the same directory is greenfield-consistent but scope-creep for this spec; flagged in the Decisions Log with a revisit trigger.

## Overview

Replace every ad-hoc `c.json({ name, ... }, status)` error response in `packages/server` and `apps/api` with a `defineErrors` variant, and consolidate the variants under `@epicenter/constants/*-errors.ts` so the client SDK and the cloud gate share the same wire shape and discriminant casing.

## Motivation

### Current State

Six routes return errors as object literals instead of `defineErrors` calls:

```ts
// packages/server/src/middleware/require-url-owner-id-matches-auth.ts:23
return c.json({ name: 'forbidden_owner_mismatch' }, 403);

// packages/server/src/middleware/require-origin-for-cookie-mutations.ts:27
return c.json({ name: 'forbidden_origin' }, 403);

// apps/api/src/autumn-gates.ts:83, 87, 101, 146
return c.json({ name: 'unknown_model', model }, 400);
return c.json({ name: 'model_requires_paid_plan', model, credits }, 403);
return c.json({ name: 'insufficient_credits', balance }, 402);
return c.json({ name: 'storage_limit_exceeded' }, 402);
```

Meanwhile, four error namespaces already use `defineErrors` with a `{ name, message, ...fields }` wire shape:

```ts
// packages/constants/src/ai-chat-errors.ts   (shared with client SDK)
export const AiChatError = defineErrors({
  Unauthorized: () => ({ message: 'Unauthorized' }),
  UnknownModel: ({ model }: { model: string }) => ({ message: `Unknown model: ${model}`, model }),
  InsufficientCredits: ({ balance }: { balance: unknown }) => ({ message: 'Insufficient credits', balance }),
  ModelRequiresPaidPlan: ({ model, credits }: { model: string; credits: number }) => ({ ... }),
  ProviderNotConfigured: ({ provider }: { provider: string }) => ({ ... }),
});

// packages/server/src/routes/assets.ts        (route-local; types not exported)
const AssetError = defineErrors({ MissingFile, InvalidVisibility, FileTypeNotAllowed, FileTooLarge, NotFound, Unauthorized });

// packages/server/src/auth/oauth-error.ts     (server-local; wire format same)
export const OAuthError = defineErrors({ InvalidToken: () => ({ ... }) });

// packages/server/src/routes/rooms.ts         (telemetry-only, never serialized)
const RoomsTelemetryError = defineErrors({ DoInstanceUpsertFailed: ... });
```

This creates problems:

1. **Live wire-format divergence (real bug).** `autumn-gates.ts` emits `'unknown_model'`, `'insufficient_credits'`, `'model_requires_paid_plan'` (snake_case, no `message`). The client SDK's `AiChatHttpError` (`packages/svelte-utils/src/create-ai-chat-fetch.ts`) parses the body and lets consumers `switch (err.detail.name)` over `'UnknownModel' | 'InsufficientCredits' | 'ModelRequiresPaidPlan' | ...`. The cloud-gate variants silently never match any case. The fix today would be to add six more cases in snake_case; the real fix is to converge on the shared definition.
2. **No `message` field on ad-hoc errors.** `toastOnError` renders `.message` as the toast description, and `AiChatHttpError.message` is set from `detail.message`. Hand-rolled objects without `message` force every client to invent a string per `name`.
3. **No type safety on receivers.** The autumn-gate object literals widen to `{ name: string; ... }`. The client cannot exhaustive-switch with `default: error satisfies never`. Adding a seventh gate cannot break callers' builds.
4. **Casing convention drift.** `MissingFile`/`FileTooLarge` (PascalCase) vs `forbidden_origin`/`insufficient_credits` (snake_case). The SDK has to remember which surface uses which.
5. **No invariant about where errors live.** Three locations today: `packages/constants/src/*-errors.ts`, `packages/server/src/*/`, and inline object literals. The next author has no documented rule to follow.

### Desired State

Every `c.json(...)` non-2xx response in `packages/server` and `apps/api` passes a `defineErrors` variant. Every wire-format variant lives in one place:

```
packages/constants/src/<domain>-errors.ts
```

After this change, the cloud gate stops inventing parallel error names; it imports `AiChatError`, `AssetError`, and `RequestGuardError` from `@epicenter/constants` and calls the factories directly.

The rule, in one sentence: **every wire-format error in this repo lives in `packages/constants/src/<domain>-errors.ts` and reaches the wire via `c.json(MyError.Variant({...}), httpStatus)`.**

## Research Findings

### How the existing wire format is consumed

`AiChatError` is the only error namespace currently shared across the package boundary. The flow:

```
packages/server/src/routes/ai.ts          (server: runtime factory)
  return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
            │
            ▼ JSON body { error: { name, message, ...fields }, data: null }
            ▼
packages/svelte-utils/src/create-ai-chat-fetch.ts   (client: throw bridge)
  if (body.error && 'name' in body.error) {
    throw new AiChatHttpError(response.status, body.error as AiChatError);
  }
            │
            ▼ propagates through TanStack AI ChatClient
            ▼
apps/{opensidian,tab-manager}/src/lib/chat/chat-state.svelte.ts
  if (chat.error instanceof AiChatHttpError)
    switch (chat.error.detail.name) {
      case 'InsufficientCredits': ...
      case 'ProviderNotConfigured': ...
    }
```

`defineErrors` factory calls produce the wellcrafted envelope (`{ data: null, error: { name, message, ...fields } }`). Clients consume `body.error`.

### What each ad-hoc site really wants

| Site | File:line | Today | Has an existing variant? |
| --- | --- | --- | --- |
| Owner mismatch gate | `middleware/require-url-owner-id-matches-auth.ts:23` | `{ name: 'forbidden_owner_mismatch' }` | No |
| CSRF Origin gate | `middleware/require-origin-for-cookie-mutations.ts:27` | `{ name: 'forbidden_origin' }` | No |
| Unknown model | `apps/api/src/autumn-gates.ts:83` | `{ name: 'unknown_model', model }` | Yes: `AiChatError.UnknownModel` |
| Model requires plan | `autumn-gates.ts:87` | `{ name: 'model_requires_paid_plan', model, credits }` | Yes: `AiChatError.ModelRequiresPaidPlan` |
| Insufficient credits | `autumn-gates.ts:101` | `{ name: 'insufficient_credits', balance }` | Yes: `AiChatError.InsufficientCredits` |
| Storage limit | `autumn-gates.ts:146` | `{ name: 'storage_limit_exceeded' }` | No (asset-domain) |
| Billing pass-through | `apps/api/src/billing-routes.ts:29-31` | Raw Autumn body | No |

**Key finding**: three of six ad-hoc cloud-gate sites already have shared-constants counterparts that the client SDK is wired for. They are not just inconsistent: they are wrong.

### Where errors live today vs. where they should live

| Namespace | Location today | Used by client SDK? | Move? |
| --- | --- | --- | --- |
| `AiChatError` | `packages/constants/src/ai-chat-errors.ts` | Yes | Keep |
| `OAuthError` | `packages/server/src/auth/oauth-error.ts` | No (server-internal handshake) | Keep |
| `AssetError` | `packages/server/src/routes/assets.ts` (route-local) | Spec `20260524T021140-asset-visibility-and-client-sdk.md` is building one | **Move to `packages/constants/src/asset-errors.ts`** |
| `RoomsTelemetryError` | `packages/server/src/routes/rooms.ts` (route-local) | No (logging only, never `c.json`'d) | Keep |
| `RequestGuardError` (new) | n/a | Yes (boundary errors any SDK request can hit) | **Create in `packages/constants/src/request-guard-errors.ts`** |

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Wire format for all non-2xx responses | 2 coherence | Wellcrafted envelope `{ data: null, error: { name, message, ...fields } }` | Matches the only existing shared error namespace (`AiChatError`) and the `AiChatHttpError` parser already in client SDK. |
| Casing convention for `name` | 2 coherence | PascalCase (`OwnerMismatch`, not `owner_mismatch`) | Matches every existing `defineErrors` call in the repo. Snake_case sites become breaking-change renames. |
| Where all wire-format variants live | 2 coherence | `packages/constants/src/<domain>-errors.ts`: one location, no two-location rule | Already established by `ai-chat-errors.ts`. Constants is dependency-free and importable by both server runtime and SDK type-only. Greenfield refinement: the earlier "two locations split by current-state SDK consumers" rule was refused because it forces a move on the first future SDK consumer and adds a decision the author has to make. |
| Reuse `AiChatError` for autumn gate vs. new `BillingError` | 1 evidence | Reuse `AiChatError.UnknownModel` / `InsufficientCredits` / `ModelRequiresPaidPlan` | These three variants already exist in shared constants and the client SDK already switches on them. Splitting into `BillingError` would force every SDK caller to handle two error types for one logical error. Verified by reading `packages/constants/src/ai-chat-errors.ts:30-55` and `packages/svelte-utils/src/create-ai-chat-fetch.ts:60-78`. |
| Storage limit goes in `AssetError` vs. `BillingError` | 3 taste | `AssetError.StorageLimitExceeded` | The error fires on POST to `/api/owners/.../assets`; the SDK caller is the asset client. Asset-shaped error means one error type per SDK call surface. |
| Middleware (security) errors namespace | 2 coherence | `RequestGuardError` with variants `OwnerMismatch`, `ForbiddenOrigin`, located at `packages/constants/src/request-guard-errors.ts` | Both variants are pre-handler 403 boundary refusals; co-locating them is honest per the `defineErrors` 2-5-variants-per-domain guideline. Splitting into single-variant `AccessError` / `CsrfError` namespaces was refused as speculative-future overhead. Location is shared constants per the one-location rule above. |
| Middleware wire-format change | 1 evidence | Accept the break: response body shifts from `{ name }` to `{ data: null, error: { name, message } }` | `defineErrors` factories return `Err(variant)` = `{ data: null, error: variant }`; passing the factory result through `c.json` produces the wellcrafted envelope. Verified by reading `packages/svelte-utils/src/create-ai-chat-fetch.ts:60-68` (already parses `body.error.name`) and grepping for production consumers of `'forbidden_origin'` / `'forbidden_owner_mismatch'`: only consumer is the middleware test file. Test updates from `body.name` to `body.error.name`. |
| Custom error class bridge (`AiChatHttpError`) for the new namespaces | 3 taste | Defer: do not add `AssetHttpError` / `ApiHttpError` yet | The bridge exists only because TanStack AI's adapter rethrows generic `Error` and discards the parsed body. Regular `auth.fetch` callers can read `response.json()` and branch on `error.name` directly. Add a bridge only when an adapter forces one. |
| Rename `'forbidden_origin'` and `'forbidden_owner_mismatch'` | 1 evidence | Yes, breaking rename to `'ForbiddenOrigin'` / `'OwnerMismatch'` | Only consumer is `require-origin-for-cookie-mutations.test.ts:30`. No production client switches on these strings (grepped repo-wide). |
| `apps/api/src/billing-routes.ts` Autumn pass-through | 3 taste | Out of scope of this pass | The body is whatever Autumn returned (`autumnErr.body` is an opaque string from a third party). Wrapping it in `defineErrors` is a separate design decision about Autumn error translation. Flagged in Open Questions. |
| Lint rule to prevent regression | 3 taste | Add a custom ESLint rule **or** a grep-based CI check that bans `c.json({ name:` object literals | Without a guard the next author writes another ad-hoc one. Cheap to add; high leverage. |

### Class 3 keeps

- Keep `RoomsTelemetryError` route-local: it is never serialized to the wire and is consumed only by `wellcrafted/logger` in the same file. Moving it would dilute the cross-package boundary's meaning. Revisit when: any consumer outside `routes/rooms.ts` needs to branch on its `name`.
- Keep `OAuthError` server-local in `packages/server/src/auth/oauth-error.ts`: it is consumed by the OAuth resource boundary in the same package. The wire format is identical to `defineErrors`. Revisit when: a non-server package needs to branch on `OAuthError.name`.

## Architecture

### Target file layout

```
packages/constants/src/
├── ai-chat-errors.ts          [unchanged]
├── asset-errors.ts            [NEW: AssetError + StorageLimitExceeded]
├── request-guard-errors.ts    [NEW: RequestGuardError.{OwnerMismatch, ForbiddenOrigin}]
└── ...                        [other constants files unchanged]

packages/server/src/
├── auth/oauth-error.ts        [unchanged this PR; see Decisions Log]
├── routes/
│   ├── ai.ts                  [unchanged: already idiomatic]
│   ├── assets.ts              [imports AssetError from @epicenter/constants/asset-errors]
│   └── rooms.ts               [unchanged: RoomsTelemetryError stays route-local]
└── middleware/
    ├── require-url-owner-id-matches-auth.ts     [uses RequestGuardError.OwnerMismatch]
    └── require-origin-for-cookie-mutations.ts   [uses RequestGuardError.ForbiddenOrigin]

apps/api/src/
├── autumn-gates.ts            [imports AiChatError + AssetError from constants]
└── billing-routes.ts          [out of scope; see Open Questions]
```

### The one rule for the next author

```
┌─────────────────────────────────────────────────────────────┐
│ Need to return a non-2xx? Two steps:                         │
│                                                              │
│ 1. Find or add the variant in                                │
│    packages/constants/src/<domain>-errors.ts                 │
│                                                              │
│ 2. Return it:                                                │
│    return c.json(MyError.Variant({...fields}), httpStatus);  │
│                                                              │
│ Never an object literal. CI grep enforces this.              │
└─────────────────────────────────────────────────────────────┘
```

### Commit plan

Three honest commits, one PR. No staged migration: there's no durable contract to migrate.

```
1. feat(constants): add request-guard, asset-error, storage-limit variants
   - Create packages/constants/src/request-guard-errors.ts
   - Create packages/constants/src/asset-errors.ts (moves AssetError from routes/assets.ts,
     adds StorageLimitExceeded variant)
   - Update packages/constants/package.json exports
   - Update packages/server/src/routes/assets.ts to import AssetError from constants

2. refactor(server,api): replace ad-hoc c.json error literals with defineErrors variants
   - Two middleware sites to RequestGuardError variants
   - Three autumn-gates AI sites to existing AiChatError variants (the real bug fix)
   - One autumn-gates storage site to AssetError.StorageLimitExceeded
   - Update the one test assertion (body.name to body.error.name, casing)

3. chore(ci): grep guard against c.json error literals
   - Add the grep check that fails CI on any future ad-hoc c.json({name: '...'}) site
```

## Implementation Plan

### Commit 1: Add error namespaces

- [ ] **1.1** Create `packages/constants/src/request-guard-errors.ts` with `RequestGuardError.{OwnerMismatch, ForbiddenOrigin}`.
- [ ] **1.2** Create `packages/constants/src/asset-errors.ts`: move the existing `AssetError` namespace from `packages/server/src/routes/assets.ts` verbatim, add `StorageLimitExceeded({ requestedBytes })`.
- [ ] **1.3** Update `packages/constants/package.json` `exports` with `./request-guard-errors` and `./asset-errors`.
- [ ] **1.4** Update `packages/server/src/routes/assets.ts` to import `AssetError` from `@epicenter/constants/asset-errors` and delete the local `defineErrors` block.

### Commit 2: Swap ad-hoc call sites

- [ ] **2.1** `packages/server/src/middleware/require-url-owner-id-matches-auth.ts`: `RequestGuardError.OwnerMismatch()`.
- [ ] **2.2** `packages/server/src/middleware/require-origin-for-cookie-mutations.ts`: `RequestGuardError.ForbiddenOrigin()`.
- [ ] **2.3** `packages/server/src/middleware/require-origin-for-cookie-mutations.test.ts`: update `body.name === 'forbidden_origin'` to `body.error.name === 'ForbiddenOrigin'`.
- [ ] **2.4** `apps/api/src/autumn-gates.ts`:
  - Line 83 to `AiChatError.UnknownModel({ model })`
  - Line 87 to `AiChatError.ModelRequiresPaidPlan({ model, credits })`
  - Line 101 to `AiChatError.InsufficientCredits({ balance })`
  - Line 146 to `AssetError.StorageLimitExceeded({ requestedBytes: file.size })`
- [ ] **2.5** Run `bun typecheck` across `packages/constants`, `packages/server`, `apps/api`, `apps/tab-manager`, `apps/opensidian` (last two compile-check the AiChatError consumers).
- [ ] **2.6** Run `bun test` in `packages/server`.

### Commit 3: CI guard

- [ ] **3.1** Add a CI step that runs `! grep -rEn "c\.json\(\s*\{\s*name:\s*['\"]" packages apps` (fails if matches found). Place in the existing CI workflow.
- [ ] **3.2** Sanity-check by reverting one site temporarily and confirming the grep fails it.

## Edge Cases

### `c.json(error, status)` envelope shape

`defineErrors` factory results return `{ data: null, error: { name, message, ...fields } }` because `Err(...)` wraps the variant. Today's ad-hoc `c.json({ name: 'foo' }, 403)` is just the raw error object, NOT the wellcrafted envelope. Existing route-local sites already pass the factory result directly (`c.json(AssetError.NotFound(), 404)`), so the body is the wellcrafted envelope. Confirm clients are reading `body.error.name`, not `body.name`. The AI fetch bridge (`create-ai-chat-fetch.ts:60-68`) already does this correctly. The middleware test (`require-origin-for-cookie-mutations.test.ts:30`) currently reads `body.name` directly because the current implementation returns a raw object literal. After this change, it must read `body.error.name`.

This is a real wire-format change for the middleware errors. Two options:
1. Accept the change. The middleware tests update; no production client switches on these errors today.
2. Have middleware return the raw error variant via `MyError.Variant()` but unwrap before serializing.

Option 1 is consistent with every other `c.json(defineErrorsVariant, ...)` call in the codebase. Recommended.

### Status code does not live with the variant

`defineErrors` produces the body. The HTTP status code is passed as the second arg to `c.json`. A future improvement could tie status codes to variants (e.g. via a sidecar map), but that's a separate spec.

### `apps/api/src/billing-routes.ts` Autumn passthrough

```ts
return c.json(body, autumnErr.statusCode as 400);
return c.json({ message: autumnErr.body }, autumnErr.statusCode as 400);
```

The first form forwards Autumn's response body unchanged (whatever shape it has). The second wraps Autumn's error string in `{ message }`. Neither uses `defineErrors`. This is a third-party translation problem, not an ad-hoc invention. Pulling it into scope means designing an `AutumnError` translation layer, which deserves its own spec. Out of scope here.

## Open Questions

1. **Should `OAuthError` move to `@epicenter/constants` for consistency?**
   - Today: lives in `packages/server/src/auth/oauth-error.ts`.
   - Argument for: rule is "shared constants for anything on the wire."
   - Argument against: only consumer is server-internal; moving widens the constants surface for no client benefit.
   - **Recommendation**: leave alone. The rule is "shared if a client SDK switches on it"; the SDK does not.

2. **Should middleware errors really be in shared constants, or in a `packages/server/src/api-errors.ts`?**
   - Constants: importable by future client SDKs that want to recognize the 403 shape.
   - Server-local: tighter import boundary, matches `OAuthError`'s placement.
   - **Recommendation**: constants. `ForbiddenOrigin` is the kind of "any SDK call can return this" boundary error that benefits from being known to every client. `OwnerMismatch` is more debatable but coupling them is simpler.

3. **CI guard: grep vs ESLint rule?**
   - Grep: one-line CI command, trivial to maintain, easy to false-positive on harmless content (e.g. variable named `name` in an unrelated object).
   - ESLint rule: AST-precise, integrates with editor lint, more setup.
   - **Recommendation**: start with a grep CI check (`grep -rE 'c\.json\(\s*\{\s*name:' packages apps && exit 1`). Upgrade to ESLint if false-positives are noisy.

4. **Should `AssetError` get a custom error class like `AiChatHttpError`?**
   - `AiChatHttpError` exists because TanStack AI's adapter swallows the body and rethrows generic `Error`. Asset reads go through `auth.fetch` directly, which already returns the `Response`.
   - **Recommendation**: not now. The asset client SDK (per spec `20260524T021140-asset-visibility-and-client-sdk.md`) reads `response.json()` and branches on `body.error.name` directly. Add the bridge only if an adapter forces one.

5. **Should the status code be encoded into the variant definition?**
   - E.g. `AssetError.NotFound` always 404; `RequestGuardError.OwnerMismatch` always 403. A sidecar map (`assetErrorStatus[name]`) could remove the magic number from call sites.
   - **Recommendation**: defer. The status-code-per-variant convention is implicit today and rarely changes; formalizing it is a separate (small) refactor.

## Decisions Log

- Keep `OAuthError` in `packages/server/src/auth/oauth-error.ts` for this PR (scope-creep refusal). Greenfield-consistent move target is `packages/constants/src/oauth-errors.ts`. Trade-off: one wire-format namespace lives in the wrong place after this PR. Revisit when: next time anyone edits the OAuth resource boundary, the close-reason format, or `OAuthError` itself.
- Keep `RoomsTelemetryError` route-local in `packages/server/src/routes/rooms.ts`: never serialized; consumed only by `wellcrafted/logger`. Revisit when: any other module needs to switch on its name.
- Keep `billing-routes.ts` Autumn passthrough untouched: it forwards a third-party response, not an invented shape. Trade-off: one location does not match the rule. Revisit when: a client needs to branch on Autumn-translated errors.

## Success Criteria

- [ ] Repo-wide grep `grep -rE 'c\.json\(\s*\{\s*name:' packages apps` returns 0 matches.
- [ ] Every `c.json(...)` non-2xx response in `packages/server` and `apps/api` passes the result of a `defineErrors` factory call.
- [ ] `apps/tab-manager` and `apps/opensidian` chat-state files compile without changes after the autumn-gates rewrite (they already switch on `UnknownModel`, `InsufficientCredits`, `ModelRequiresPaidPlan`).
- [ ] The "decision tree" in Architecture (or its `AGENTS.md` equivalent) tells a new author where to add the next error in under 30 seconds.
- [ ] `bun test` and `bun typecheck` pass across all touched packages.
- [ ] CI grep guard (or ESLint rule) added and verified to fail on a deliberately-introduced ad-hoc `c.json` object literal.

## References

- `packages/constants/src/ai-chat-errors.ts`: the gold-standard shared error namespace; `AiChatHttpError` bridge.
- `packages/svelte-utils/src/create-ai-chat-fetch.ts`: how the client SDK parses `{ name, message, ...fields }` into a typed throw.
- `packages/server/src/routes/assets.ts:85-108`: current `AssetError` definition to migrate into constants.
- `packages/server/src/routes/ai.ts:72,79`: example of `c.json(MyError.Variant(...), status)` done right.
- `packages/server/src/auth/oauth-error.ts`: example of correct server-local `defineErrors`.
- `packages/server/src/middleware/require-url-owner-id-matches-auth.ts:23`: site to migrate.
- `packages/server/src/middleware/require-origin-for-cookie-mutations.ts:27`: site to migrate.
- `packages/server/src/middleware/require-origin-for-cookie-mutations.test.ts:30`: test assertion to update.
- `apps/api/src/autumn-gates.ts:83,87,101,146`: four sites to migrate.
- `specs/20260524T021140-asset-visibility-and-client-sdk.md`: concurrent asset SDK spec; this change moves `AssetError` into the location that spec depends on.
- `.claude/skills/define-errors/SKILL.md`: wellcrafted `defineErrors` patterns and anti-patterns; the rule this spec enforces.
