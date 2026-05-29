# Omega Deployment Profiles

**Date**: 2026-05-28
**Status**: Draft
**Owner**: Braden
**Supersedes**: None

## One Sentence

Epicenter has one reusable server core; each deployment profile owns its trust boundary, billing boundary, secrets, and membership rule.

## Omega Rule

```txt
ownerId    = data partition
customerId = billing identity
deployment = trust boundary
membership = admission policy
```

Do not collapse those four values into one abstraction.

## Collapse Pass Log

Claude Code could not run because the account is over the weekly limit until May 30 at 1am America/Los_Angeles. This spec has been locally grilled three times instead:

```txt
Pass 1: close fake-open decisions
  -> choose apps/team-api for the first self-hosted team deployable
  -> document apps/api as hosted personal now, defer rename
  -> use static allowed member emails first

Pass 2: delete repetition
  -> merge greenfield findings into decisions
  -> remove duplicate product sentence blocks
  -> keep one boundary table

Pass 3: tighten implementation spine
  -> Phase 1 docs only
  -> Phase 2 smallest runnable team app
  -> Phase 3 billing isolation only after the team app proves the leak
```

## Current Shape

```txt
apps/api
  -> createServerApp()
  -> personal()
  -> authApp
  -> session
  -> rooms
  -> assets + Autumn storage policy
  -> AI + Autumn credit policy
  -> /api/billing/*
  -> dashboard billing UI
```

Good:

```txt
@epicenter/server is mostly billing-free.
personal() and team({ isMember }) are deployment choices.
mountAiApp and mountAssetsApp already accept deployment policies.
TEAM_OWNER_ID is documented as durable bytes, not casual config.
```

Muddy:

```txt
apps/api sounds generic, but it is hosted personal cloud.
apps/api/README.md still reads like the generic hub README.
API_ROUTES.billing makes billing look universal.
packages/billing sounds reusable, but it is hosted commercial billing.
apps/server/README.md preserves an older self-hostable-server story.
```

## Target Profiles

### Hosted Personal Cloud

```txt
apps/api
  -> @epicenter/server
  -> personal()
  -> authApp
  -> session
  -> rooms
  -> assets + hosted billing storage policy
  -> AI + hosted billing credit policy
  -> hosted billing routes
  -> dashboard billing UI
```

```txt
ownerId    = user.id
customerId = user.id
Autumn     = enabled
secrets    = Epicenter Cloud
```

### Self-Hosted Team

```txt
apps/team-api
  -> @epicenter/server
  -> team({ isMember })
  -> authApp
  -> session
  -> rooms
  -> assets
  -> AI with deployment-owned provider keys or BYOK
```

```txt
ownerId    = TEAM_OWNER_ID ("team")
customerId = none
Autumn     = absent
secrets    = deployment-owned
```

Self-hosted team has no `/api/billing/*`, no dashboard billing UI, no Autumn runtime checks, and no `AUTUMN_SECRET_KEY`.

### Future Hosted Team Cloud

```txt
apps/hosted-team-api
  -> @epicenter/server
  -> hosted org membership
  -> owner partition policy chosen by product
  -> hosted billing with customerId = org/team id
  -> optional entityId = seat, user, or project
  -> admin billing dashboard
```

This is a third deployment profile. It is not self-hosted team with Autumn turned on.

## Boundary Table

| Concern | Hosted personal cloud | Self-hosted team | Future hosted team cloud |
| --- | --- | --- | --- |
| auth | Epicenter Cloud | deployment | Epicenter Cloud |
| ownerId | user id | `TEAM_OWNER_ID` | org/team id only if content is org-owned |
| membership | none | static allowed email list first | hosted org membership |
| billing customer | user id | none | org/team/customer id |
| AI provider keys | Epicenter env or BYOK | deployment env or BYOK | Epicenter env, BYOK, or org policy |
| storage provider | Epicenter R2 | deployment bucket | Epicenter hosted storage |
| compute provider | Epicenter Cloudflare | deployment Cloudflare first | Epicenter Cloudflare |
| encryption root keys | Epicenter `ENCRYPTION_SECRETS` | deployment `ENCRYPTION_SECRETS` | Epicenter keys, probably per org partition |
| `/api/billing/*` | yes | no | yes, admin scoped |
| Autumn | yes | no | maybe |
| local IndexedDB prefix | `server/owners/<userId>` | `server/owners/team` | `server/owners/<orgId>` if org-owned |

## Closed Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| First self-hosted shape | `apps/team-api` | A runnable app proves the composition. A template can come later by copying the app. |
| `apps/api` rename | Do not rename in Phase 1 | The low-risk fix is to document it as hosted personal cloud. Rename only if the name keeps causing mistakes. |
| Self-hosted membership | Static allowed email list first | It is deployment-owned, concrete, and does not require a new table or admin UI. |
| Team owner id | Keep `TEAM_OWNER_ID = "team"` | One deployment equals one team partition. An env var changes durable data. |
| Billing in server core | Refuse | Billing is hosted deployment policy, not owner mechanics. |
| Hosted team cloud | Defer | It needs real product demand for hosted org admin, seats, invoices, and shared hosted data. |
| Non-Cloudflare self-hosting | Defer | `createServerApp()` currently assumes Hyperdrive, R2, KV, and Durable Objects. |

## Autumn Grounding

DeepWiki against `useautumn/autumn` confirmed:

```txt
customerId = stable billing identity
entityId   = optional sub-customer scope
check      = customerId, optional entityId
track      = customerId, optional entityId
attach     = customerId, optional entityId
getOrCreate customer = customerId
```

Implications:

```txt
hosted personal cloud:
  customerId = user.id

self-hosted team:
  no Autumn customer
  no per-request Autumn checks

future hosted team cloud:
  customerId = org/team id
  entityId = seat, user, or project only if useful
```

## Team Owner Id

Keep:

```txt
TEAM_OWNER_ID = "team"
```

This is valid only while the deployment is one team:

```txt
database       = one team
bucket         = one team
DO namespace   = one team
root keyring   = one team trust boundary
membership     = one team admission policy
```

Reject:

```txt
TEAM_OWNER_ID = env.TEAM_OWNER_ID
```

Reason:

```txt
"team" is durable data:
  HKDF label
  URL path segment
  R2 key prefix
  Durable Object name prefix
  IndexedDB prefix
```

Trigger to replace it:

```txt
One runtime, database, or storage namespace must host multiple independent teams whose data, keys, billing, deletion, or membership must be managed separately.
```

When that trigger happens:

```txt
ownerId    = tenant/org id
customerId = org billing id
isMember   = org membership policy
migration  = durable-data migration, not config rename
```

## Implementation Plan

### Phase 1: Docs Only

Goal:

```txt
Make the deployment profiles explicit before code moves.
```

Files:

```txt
specs/20260528T054721-omega-deployment-profiles.md
apps/api/README.md
apps/api/package.json
docs/architecture/account-and-document-ownership.md
docs/encryption.md
docs/guides/consuming-epicenter-api.md
apps/server/README.md
packages/constants/src/identity.ts comments if needed
packages/server/src/index.ts comments if needed
packages/server/src/cloudflare-bindings.d.ts comments if needed
```

Required edits:

```txt
apps/api = hosted personal cloud
self-hosted team = sibling deployable
Autumn = hosted billing only
apps/server/README.md = align or mark superseded
TEAM_OWNER_ID = single-team deployment sentinel
```

### Phase 2: Smallest Team App

Goal:

```txt
Add a runnable self-hosted team app with no billing surface.
```

Files:

```txt
apps/team-api/package.json
apps/team-api/src/index.ts
apps/team-api/wrangler.jsonc
apps/team-api/README.md
apps/team-api/AGENTS.md
apps/team-api/CLAUDE.md
```

Composition:

```txt
const ownership = team({
  isMember: (c) => allowedEmails.has(c.var.user.email),
})

createServerApp()
  -> authApp
  -> mountSessionApp({ ownership })
  -> mountRoomsApp({ ownership })
  -> mountAssetsApp({ ownership })
  -> mountAiApp({ auth: requireBearerUser })
```

Deployment-owned config:

```txt
ALLOWED_MEMBER_EMAILS
BETTER_AUTH_SECRET
ENCRYPTION_SECRETS
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
OPENAI_API_KEY
GEMINI_API_KEY
HYPERDRIVE
ASSETS_BUCKET
SESSION_KV
ROOM
```

Must not appear:

```txt
AUTUMN_SECRET_KEY
autumn-js
@epicenter/billing
/api/billing/*
dashboard billing UI
hosted plan catalog
```

### Phase 3: Billing Isolation

Goal:

```txt
Make hosted billing visibly owned by hosted cloud.
```

Files:

```txt
apps/api/src/billing/policies.ts
apps/api/src/billing/service.ts
apps/api/src/billing/routes.ts
apps/api/src/billing/autumn-products.ts
apps/api/autumn.config.ts
packages/billing/src/catalog.ts
packages/billing/src/ai-model-pricing.ts
packages/billing/src/contracts.ts
packages/constants/src/api-routes.ts
packages/constants/src/billing-errors.ts
apps/dashboard/*
```

Acceptable end states:

```txt
small:
  keep packages/billing, but document/package-name it as hosted billing

medium:
  move billing route constants out of shared API_ROUTES

large:
  create a hostedBilling module that owns policies, routes, catalog, and Autumn product mapping
```

Refusals:

```txt
Do not generalize billing for self-hosting.
Do not add no-op billing adapters.
Do not move Autumn into @epicenter/server.
```

## Verification

After Phase 1:

```txt
rg -n "generic hub|self-host.*apps/api|fork.*wrangler" apps/api/README.md docs apps/server
```

Expected:

```txt
No docs tell self-hosted teams to fork hosted personal cloud and remove billing.
```

After Phase 2:

```txt
rg -n "Autumn|AUTUMN_SECRET_KEY|/api/billing|@epicenter/billing|autumn-js" apps/team-api
bun run --cwd apps/team-api typecheck
```

Expected:

```txt
No Autumn hits in apps/team-api.
No billing routes in apps/team-api.
No hosted dashboard dependency in apps/team-api.
```

Existing package checks:

```txt
bun run --cwd apps/api typecheck
bun run --cwd packages/server typecheck
bun test packages/server
```

Manual route check:

```txt
GET /api/session
  hosted personal -> ownerId = user.id
  self-hosted team -> ownerId = "team"

GET /api/billing/overview
  hosted personal -> exists
  self-hosted team -> absent
```

## Risks

1. `apps/api` rename churn can distract from the real boundary. Document first.
2. `API_ROUTES.billing` makes hosted billing look universal. Move it only when Phase 3 starts.
3. `packages/billing` sounds generic. Either rename/docs-fence it or move it under hosted app ownership.
4. `apps/server/README.md` may keep a stale architecture alive. Align it or mark it superseded in Phase 1.
5. `TEAM_OWNER_ID` is durable data. Treat changes as migrations.
6. `ALLOWED_MEMBER_EMAILS` is simple but not an admin system. That is intentional for the first team app.
7. Self-hosted team must not inherit Infisical or Epicenter Cloud secret assumptions.
8. Non-Cloudflare runtime portability is a separate project.

## Non-Goals

1. Do not implement hosted team cloud now.
2. Do not implement multi-tenant org billing now.
3. Do not make `TEAM_OWNER_ID` configurable.
4. Do not add Autumn to self-hosted team.
5. Do not move Autumn into `@epicenter/server`.
6. Do not add no-op billing middleware.
7. Do not solve non-Cloudflare runtime portability.
8. Do not preserve compatibility unless a real deployed contract exists.

## Review Gate

Before implementation, review only these remaining choices:

```txt
1. Is static ALLOWED_MEMBER_EMAILS acceptable for the first team app?
2. Should apps/server/README.md be rewritten or marked superseded?
3. Should Phase 1 rename apps/api/package.json description only, or also comments in src/index.ts?
```

Everything else is closed for this pass.
