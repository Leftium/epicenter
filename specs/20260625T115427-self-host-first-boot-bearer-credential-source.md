# Self-host's local credential source: a first-boot bearer on the resolveUser seam

**Date**: 2026-06-25
**Status**: Draft
**Owner**: Braden
**Branch**: none yet (execute on a fresh branch off `main` after `feat/client-instance-setting` merges)
**Parent map**: [`specs/20260624T223835-privacy-is-a-deployment-self-host-and-relay-anchor-gradations.md`](20260624T223835-privacy-is-a-deployment-self-host-and-relay-anchor-gradations.md) (this is Wave 3, expanded)
**Records**: [ADR-0070](../docs/adr/0070-self-host-adds-no-new-ownership-or-auth-mode.md) (the locked decision; this spec only pins the default it delegated)

## One Sentence

A self-hoster logs into their own box with a bearer token the star prints once at first boot: a new `resolveUser` credential source that resolves to one bootstrapped user under the existing `personal` partition, with zero new ownership mode and zero no-auth fork.

## How to read this spec

```
Read first:        One Sentence · Current State · The locked design · Implementation Plan · Success Criteria
Read to decide:    Design Decisions · Open Questions
Historical/context: Parent map Wave 3, ADR-0070
```

## Overview

Add a local credential source so a solo self-host needs no Google OAuth app. This is the last of the three self-host gaps (the other two, the client instance-URL setting and the Bun star, land on `feat/client-instance-setting`). It removes caveat 3 of the parent map: "a self-hoster must register a Google app to log into their own box."

## Motivation

### Current State

The only wired sign-in is Google OAuth. `packages/server/src/auth/base-config.ts` disables email/password on purpose (better-auth 1.5.6 has no local email-verification gate and no mail sender is wired, so a local account is an account-takeover path).

The seam to vary this already exists and is shipped on `feat/client-instance-setting`:

```ts
// packages/server/src/types.ts:42
export type ResolveUser = (c: Context) => MaybePromise<Result<AuthUser, OAuthErr>>;

// packages/server/src/server-app.ts:164  — the per-deployment knob, defaulting to OAuth
resolveUser = resolveRequestOAuthUser,
// ...stamped onto every request at server-app.ts:228
c.set('resolveUser', resolveUser);
```

And a credential source that is NOT OAuth already exists, but only as a dev bypass:

```ts
// apps/api/dev-auth.ts  (and the duplicated apps/self-host/dev-auth.ts)
// Authorization: Bearer dev:<userId>  ->  { id: <userId>, email: <userId>@dev.invalid }
// localhost-guarded, no secret: a BYPASS, quarantined so it can never ship.
export const resolveDevUser: ResolveUser = async (c) => { /* ... */ };
```

This creates problems:

1. **The cloud dependency contradicts self-host.** To run your own private box you register a Google OAuth app and route your login intent through Google. That is exactly the topology self-host is supposed to escape.
2. **The only non-OAuth resolver is a bypass, not a credential.** `resolveDevUser` trusts any `dev:<id>` on localhost with no secret. It proves the seam works; it is not a thing you can expose.
3. **Config A in the parent map is blocked.** The flagship "solo homelab, always-on box" config is `personal` + "local bearer token", and the token source is the starred gap.

### Desired State

`bun apps/api/server.ts` on a clean box prints a token once. The operator pastes it into the client (the Wave 2 instance setting) and is in. No Google, same `personal` data shape as hosted.

## The locked design (what this spec pins)

ADR-0070 decided self-host adds **no new ownership mode and no new auth gate**; it delegated the *specific default credential* to this spec. The parent map already drew it (config A): solo self-host is `personal` + a local bearer. This spec pins that and nothing more.

```
  AXIS 1 · PARTITION (OwnershipRule)        AXIS 2 · CREDENTIAL SOURCE (resolveUser)
     personal  owners/<userId>/               OAuth         (shipped, default)
     shared    owners/shared/ + admit()       dev bearer    (shipped, localhost bypass)
        |                                      first-boot bearer   <- THIS SPEC
        |                                      reverse-proxy header (deferred escape hatch)
        |                                      email/password        (deferred escape hatch)
        |
   solo self-host = personal  x  first-boot bearer
        not a new OwnershipRule.kind, not a no-auth fork: one cell of the grid.
```

Why `personal` and not `shared(admit: always)` (both yield one partition for one user):

- **Hosted symmetry.** Hosted is `personal` (`owners/<userId>/`). Solo self-host as `personal` is the same data shape; the star you run and the star Epicenter runs differ only in who holds the keyboard.
- **Isolation-by-default is the safe growth path.** If a second principal ever appears, `personal` isolates them and you opt *into* sharing one workspace; `shared` fuses them and you cannot un-fuse. The partition choice should answer "what does a second user mean here", never "I am currently alone".
- **`admit` keeps its meaning.** `admit` is the membership gate for a co-owned partition. A solo box has no membership question; `admit: always` is a no-op pretending to be a policy.

## Design Decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| Solo partition | 2 coherence | `personal`, keyed by the bootstrapped user id | ADR-0070 + hosted symmetry + isolation-by-default (above). Pins the default the ADR delegated. |
| Credential mechanism | 2 coherence | A bearer token validated against a boot secret, on `resolveUser` | One total gate; the productionized sibling of `resolveDevUser`. No new gate, no no-auth branch (ADR-0070). |
| Resolver home | 3 taste | A validating factory in `packages/server` (NOT duplicated per-deployable like the dev bypass) | The dev bypass is duplicated + quarantined *because* it is a bypass (ADR-0066). A real secret-checked credential has no bypass risk, so it earns a shared home. |
| Bootstrap identity | 3 taste | Generate a stable user id at first boot, persist it separately from the secret | Partition `owners/<id>/` must survive a token rotation; a guessable constant id is worse than a generated one. |
| `solo()` / `sovereign()` preset factory | Deferred | Compose `personal()` + bearer inline in the entry | ADR-0070: factory "only if ergonomics warrant". Earn it when the composition repeats in 2+ entries, not before. |
| Reverse-proxy header resolver | Deferred | Named escape hatch, not built now | Solo bearer covers the flagship case; multi-user homelab is config C, a later want. |
| Re-enable email/password | Deferred | Escape hatch only, never the default | Needs a mail sender for reset + carries takeover risk (ADR-0070). |

## Architecture

The bearer resolver slots into the seam that already exists. Nothing downstream of `resolveUser` changes: the 401 gate, the `personal` partition, and every owner-scoped route never learn that "self-host" or "bearer" exists.

```
request ──Authorization: Bearer <token>──▶ resolveUser (injected per deployment)
                                              │
   ┌──────────────────────────────────────────┼───────────────────────────────┐
   │ resolveRequestOAuthUser (default)         │ resolveBearerUser(secret, user) │  <- new
   │   OAuth bearer/cookie -> Better Auth      │   timing-safe eq vs secret      │
   └──────────────────────────────────────────┴───────────────────────────────┘
                                              │ Ok(AuthUser)            │ Err(InvalidToken)
                                              ▼                         ▼
                              personal() -> owners/<user.id>/        401 (one gate)
```

### The credential-source catalog (after this spec)

```
resolveRequestOAuthUser            OAuth bearer/cookie  -> Better Auth user     shipped (default)
resolveDevUser                     Bearer dev:<id>      -> synthetic, localhost  shipped (dev bypass)
resolveBearerUser(secret, user)    Bearer <secret>      -> the bootstrap user    THIS spec
resolveProxyHeaderUser(header)     X-Webauth-User       -> user from trusted proxy   deferred
```

## Implementation Plan

### Phase 1: the resolver (pure, testable)

- [ ] **1.1** Add `resolveBearerUser(secret: string, user: AuthUser): ResolveUser` in `packages/server`. Read the `Authorization: Bearer <token>`; `timingSafeEqual` against `secret`; `Ok(user)` on match, else `OAuthError.InvalidToken()`. Mirror the arm shape of `resolveDevUser` so the surface wrappers reject it unchanged.
- [ ] **1.2** Unit test: match -> the user; wrong secret, missing header, non-bearer -> `InvalidToken`. Timing-safe path covered.

### Phase 2: first-boot token + bootstrap identity

- [ ] **2.1** Decide storage (see Open Questions) and implement: at boot, if no credential exists, generate a high-entropy secret and a stable user id, persist both, and print the token once to the console (loud, one-time).
- [ ] **2.2** Wire `apps/api/server.ts` (the personal star) so a self-host invocation injects `resolveBearerUser(secret, bootstrapUser)` instead of the OAuth default, while production hosted Epicenter keeps OAuth. The seam is already there (`startBunServer({ resolveUser })`); this is a composition choice in the entry, not a library change.
- [ ] **2.3** Confirm `personal()` keys the partition off `bootstrapUser.id`, so the data lives at `owners/<bootstrapId>/`.

### Phase 3: prove (Build, Prove, then it ships)

- [ ] **3.1** Extend the runtime smoke (sibling of `apps/self-host/scripts/smoke.ts`, but personal mode): valid bearer -> 200 + a room under `owners/<bootstrapId>/`; missing/invalid bearer -> 401.
- [ ] **3.2** Live-run it against `bun apps/api/server.ts` + real Postgres + S3.

### Phase 4 (deferred): escape hatches

- [ ] **4.1** `resolveProxyHeaderUser` for multi-user/SSO homelabs (the Gitea `X-WEBAUTH-USER` pattern), `personal` partition per header identity.
- [ ] **4.2** Opt-in email/password provider for the no-proxy browser-login case (needs a mail sender first).

## Edge Cases

### No token on boot
1. Fresh box, no persisted credential.
2. The star generates + persists secret and id, prints the token once.
3. Proceeds. Solo means "the box owner is whoever holds this token", so this does NOT fail closed the way the shared wiki's empty `ALLOWED_MEMBER_EMAILS` does.

### Token rotation
1. Operator regenerates the secret.
2. The bootstrap user id is persisted *separately*, so it is unchanged.
3. Data partition `owners/<bootstrapId>/` survives; only the secret changed. (Depends on decision "Bootstrap identity" above.)

### Request with no / wrong token
1. Any owner-scoped route.
2. `resolveBearerUser` returns `InvalidToken`.
3. 401 at the one gate, same as a bad OAuth token. No null-user branch downstream.

## Open Questions

1. **Where does the first-boot credential live?**
   - Options: (a) a `0600` file like `.epicenter/credentials.json` (the local-books precedent: single file, keychain deleted), auto-generated; (b) an env var `SELF_HOST_BEARER_TOKEN` the operator sets, validated in the boot env contract like the rest of `server.ts`; (c) hashed in Postgres.
   - **Recommendation**: (a) auto-generate to a `0600` file and print once. "Printed at first boot" implies the *star* mints it, not the operator, which (b) does not give you. Keep it leaning open; (b) is the lower-effort first cut if file IO in the entry feels heavy.

2. **What identity does the bearer resolve to?**
   - Options: a fixed constant id (`local`) vs a generated-and-persisted id.
   - **Recommendation**: generate + persist, so the partition is stable and not a guessable constant. Email like `owner@localhost.invalid`. Leave the exact shape open.

3. **Resolver in `packages/server` or duplicated per entry?**
   - The dev bypass is duplicated + quarantined on purpose (ADR-0066, keep bypasses out of the shared lib). The bearer is a real secret-checked credential, not a bypass.
   - **Recommendation**: shared in `packages/server`. Re-confirm at implementation that nothing about it wants quarantine.

4. **Does solo self-host run `apps/api` (personal) or a new entry?**
   - `apps/self-host` is the *shared wiki* (config D: `shared` + OAuth + `admit`). Solo is `apps/api`'s personal star with the bearer resolver.
   - **Recommendation**: reuse `apps/api/server.ts`; do not conflate the two deployables. Confirm the entry cleanly supports "personal + bearer" without dragging in hosted-only billing.

## Success Criteria

- [ ] `bun apps/api/server.ts` on a clean box prints a token once and is idempotent across restarts (no re-print, no new identity).
- [ ] A request bearing the token resolves to the bootstrap user and opens a room under `owners/<bootstrapId>/`.
- [ ] A request without / with a wrong token gets 401.
- [ ] A solo self-host completes with no Google OAuth app registered.
- [ ] ADR-0070 is untouched (no new mode, no no-auth fork); this spec only pinned solo = `personal` + bearer.
- [ ] Parent map Wave 3 row checked; this spec deleted on landing.

## References

- `packages/server/src/types.ts:42` - `ResolveUser` contract.
- `packages/server/src/server-app.ts:164,228` - where `resolveUser` is injected and defaulted to `resolveRequestOAuthUser`.
- `packages/server/src/ownership.ts:44` - `personal()`; `:47` `shared()`.
- `apps/api/server.ts`, `apps/api/dev-auth.ts` - the personal star's Bun entry and the dev resolver this productionizes.
- `apps/self-host/dev-auth.ts`, `apps/self-host/scripts/smoke.ts` - the quarantined dev-resolver pattern and the shared-mode smoke to mirror.
- `packages/server/src/auth/base-config.ts` - where email/password is disabled.
- `docs/adr/0070-self-host-adds-no-new-ownership-or-auth-mode.md` - the locked decision.
