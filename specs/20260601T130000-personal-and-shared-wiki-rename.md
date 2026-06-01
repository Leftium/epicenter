# Personal and Shared Wiki: Greenfield Rename

Status: proposed
Date: 2026-06-01
Precondition: greenfield. No self-hosted deployment has written data under `owners/team/...`. This plan is only free to execute while that remains true.

## Why

The multi-user deployment mode is named `team`. The name lies. It promises seats, roles, admin consoles, SSO, audit logs, per-document ACLs, and offboarding with revocation: an entire SaaS product the forty lines of code behind it cannot deliver. The honest product is two flat wikis:

```
personal wiki   one person, their identity IS the partition, nothing to administer
shared wiki     a fixed, vetted set of people share one partition as equals;
                membership is the only access control; no roles, no tiers
```

See `docs/articles/20260601T120000-personal-wiki-or-shared-wiki-the-permanent-refusal.md` for the full argument. This spec is the mechanical plan to make the code say what the product is.

## The decided names

Two axes, never welded. The operator axis lives in the folder; the topology axis lives in the ownership rule.

```
                          BEFORE                      AFTER                  changes?
ownership factory A       personal()                  personal()             KEPT (maps to "personal wiki")
ownership factory B       team({ isMember })          shared({ admit })       RENAMED
union discriminant        'personal' | 'team'         'personal' | 'shared'   RENAMED (B only)
membership predicate type IsMember                    Admit                   RENAMED
durable sentinel          TEAM_OWNER_ID = 'team'      SHARED_OWNER_ID='shared' RENAMED + BYTES CHANGE
self-host deployable      apps/team-api               apps/self-host          RENAMED (operator axis)
hosted deployable         apps/api                    apps/api                KEPT (see Non-Goals)
product noun (docs/UI)    "team"                      "shared wiki"           RENAMED
```

Rationale for the predicate word: the existing tests already name their fixtures `admitAll`, `admitNone`, `admitAcme` (`require-ownership.test.ts:79`). "Admit" is already the mental model. `shared({ admit })` reads as "shared partition, admit this user?" with no roster/seat baggage that `isMember` carries.

`personal()` is unchanged on purpose. "Personal" is not a lie; it is the product noun. Code and product now share one word.

## The one irreversible decision

`SHARED_OWNER_ID` bytes. Today `TEAM_OWNER_ID = asOwnerId('team')` and that string is, per its own doc comment in `packages/identity/src/identity.ts:32`, the HKDF derivation label, the `:ownerId` path segment, the R2 key prefix, the Durable Object name prefix, and the local IndexedDB key prefix for every shared deployment.

```
owners/team/rooms/<id>      ->   owners/shared/rooms/<id>
owners/team/assets/<id>     ->   owners/shared/assets/<id>
HKDF label "team"           ->   HKDF label "shared"   (re-derives the keyring)
```

Changing `'team'` to `'shared'` is free now and a full R2 + DO + keyring migration the instant one deployment writes data. The gate on this whole plan: confirm zero shared deployments hold data, then change the bytes in the same PR as the symbol rename. If any data exists, STOP: this becomes a migration spec, not a rename.

## Blast radius (verified by grep)

The type `OwnerId` does NOT change, so the 59 files that reference it are untouched. The actual rename surface is narrow:

```
DEFINE sites
  packages/identity/src/identity.ts        TEAM_OWNER_ID -> SHARED_OWNER_ID, bytes, doc comments
  packages/server/src/ownership.ts         team()->shared(), 'team'->'shared', IsMember->Admit,
                                           resolveOwnerPartition switch arm, doc comments

CONSUMERS
  packages/server/src/index.ts             re-export: team -> shared
  packages/server/src/middleware/require-ownership.ts (+ .test.ts)   doc + test fixtures
  packages/server/src/routes/{session,rooms,assets}.ts               doc comments only
  packages/server/src/owner.ts             doc comments only ("team mode" -> "shared mode")
  apps/team-api/worker/index.ts            team({isMember}) -> shared({admit}); moves with folder

DEPLOYABLE FOLDER
  apps/team-api/  -> apps/self-host/        package.json name, wrangler.jsonc name, tsconfig,
                                           README.md, AGENTS.md, CLAUDE.md shim, worker/,
                                           worker-configuration.d.ts

LIVING DOCS (update; do not leave drifted)
  README.md (root)                         lines ~71-84
  apps/api/README.md, apps/api/worker/index.ts   doc comments referencing "team"
  .agents/skills/auth/SKILL.md             lines ~503-514 carry the literal union code

HISTORICAL (do NOT rewrite)
  specs/2026052*.md                        prior planning docs are a record; leave them stale
```

## Phased checklist

Ordered by dependency. Each phase compiles and tests green before the next.

### Phase 1: ownership vocabulary in `packages/server` + `packages/identity`
- [ ] **1.1** `identity.ts`: rename `TEAM_OWNER_ID` -> `SHARED_OWNER_ID`, change value `'team'` -> `'shared'`, rewrite the two doc comments (`personal vs team` -> `personal vs shared`, "team mode" -> "shared mode").
- [ ] **1.2** `ownership.ts`: rename `team` -> `shared`, option `isMember` -> `admit`, type `IsMember` -> `Admit`, union arm `{ kind: 'team'; ... }` -> `{ kind: 'shared'; admit: Admit }`, `resolveOwnerPartition` `case 'team'` -> `case 'shared'` (import `SHARED_OWNER_ID`). Rewrite doc comments.
- [ ] **1.3** `server/src/index.ts`: update the `personal` / `shared` re-export and the composing-comment.
- [ ] **1.4** Doc-comment sweep in `require-ownership.ts`, `routes/{session,rooms,assets}.ts`, `owner.ts`: every "team mode" -> "shared mode", "personal: ... ; team: ..." -> "personal: ... ; shared: ...".
- [ ] **1.5** `require-ownership.test.ts`: `import { ..., shared }`, `describe('team(...)')` -> `describe('shared(...)')`, `team({ isMember: ... })` -> `shared({ admit: ... })`. Fixture names `admitAll`/`admitNone`/`admitAcme` already fit.
- [ ] Gate: `bun run --filter @epicenter/server typecheck && bun test packages/server` green.

### Phase 2: rename the deployable folder `apps/team-api` -> `apps/self-host`
- [ ] **2.1** `git mv apps/team-api apps/self-host`.
- [ ] **2.2** `package.json`: rename the package (e.g. `@epicenter/api-team` -> `@epicenter/self-host`, match actual current name), update `description`.
- [ ] **2.3** `wrangler.jsonc`: worker `name` and any `ALLOWED_MEMBER_EMAILS` var comment.
- [ ] **2.4** `worker/index.ts`: `team({ isMember })` -> `shared({ admit })`, the predicate arg rename, the header doc comment ("self-hosted team Worker" -> "self-hosted shared-wiki Worker"), `mode: 'team'` health response -> `mode: 'shared'`.
- [ ] **2.5** `README.md` + `AGENTS.md` + `CLAUDE.md` shim: reframe as "shared wiki" reference; keep community-supported + zero-knowledge framing.
- [ ] **2.6** Update any root `turbo.json` / CI / workspace globs that named the old package path.
- [ ] Gate: `bun run --filter @epicenter/self-host typecheck`; deploy dry-run (`wrangler deploy --dry-run`) if available.

### Phase 3: living docs
- [ ] **3.1** Root `README.md` lines ~71-84: `team({ isMember })` -> `shared({ admit })`, "self-hosted team" -> "self-hosted shared wiki".
- [ ] **3.2** `apps/api/README.md` + `apps/api/worker/index.ts` header comment: sibling reference "team deployments" -> "shared-wiki self-host".
- [ ] **3.3** `.agents/skills/auth/SKILL.md` ~503-514: update the literal union/factory code block to the new names so the skill does not drift.
- [ ] Gate: `rg -n "\bteam\(|TEAM_OWNER_ID|kind: 'team'|isMember" --glob '!specs/**' --glob '!docs/articles/2026052*'` returns nothing in code or living docs.

### Phase 4 (OPTIONAL, separable): `apps/api` -> `apps/cloud`
Deferred by default. "api" is imprecise (both deployables are APIs) but it is not a lie, so it carries no false promise and no durable string. Do this only if the operator-axis cohesion is judged worth the package/wrangler/CI churn. Trigger to revisit: when a second hosted deployable or a docs pass makes the "api" name actively confusing.

## Non-goals (explicit refusals)

- `perUser()`: rejected. `personal()` matches the product noun; renaming it adds churn and breaks the personal-wiki/personal() symmetry.
- Rewriting historical specs under `specs/`: rejected. They are a dated record of how we got here.
- `apps/api` -> `apps/cloud` in this PR: deferred to Phase 4.
- Any admin/role/ACL scaffolding: permanently refused. The shared wiki is flat by design.

## Verification

```
bun run typecheck                 # whole monorepo
bun test packages/server          # ownership + middleware suites
rg -n "TEAM_OWNER_ID|\bteam\(\{|kind: 'team'" --glob '!specs/**'   # expect: no hits
```

The acceptance test for the rename is a reader test: open `packages/server/src/ownership.ts` and `apps/self-host/worker/index.ts` cold. Every name on the owner-id chain (factory, discriminant, sentinel, URL segment, keyring label) reads `personal` or `shared`. The word `team` appears nowhere in the live system.
