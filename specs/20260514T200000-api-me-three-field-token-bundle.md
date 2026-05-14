# Identity comes from `/api/me`, not `id_token`

**Date**: 2026-05-14
**Status**: Proposed
**Supersedes**:
- `specs/20260514T154500-id-token-bearing-encryption-keys.md` (the id_token-carries-keys design)
- `specs/20260514T160000-execute-id-token-and-oob-cli.md` (the Wave 1-4 execution plan based on that design)
**Composes with**: `specs/20260514T120000-machine-auth-oob-clean-break.md` (the OOB CLI flow; this spec adjusts the persisted shape it writes from 4 fields to 3)

## One Sentence

```
Three fields persist (access_token, refresh_token, expires_at);
identity comes from GET /api/me, fetched once per sign-in and cached
in memory; there is no id_token in the bundle, no JWT-decode dance
on the client, and no signed envelope carrying capability material.
```

This is the cohesion sentence. Anything that does not preserve it belongs in a different spec.

## Why this exists (and why the previous spec doesn't)

The previous spec proposed that the OAuth `id_token` carry a custom `workspace_encryption_keys` claim. Clients would decode the id_token on every read to extract both identity (`{ user: { id, email } }`) and capability material (`{ encryptionKeys }`). The pitch was: one token bundle, decode on read, three storage cells share one arktype, no `/workspace-identity` round-trip.

The pitch is half-true and the half that's true does not require the rest. The genuine wins (no second storage adapter; one decode path; freshness story for identity) hold up. The mechanism (id_token-as-capability-carrier) does not. The critique that surfaced before any code shipped:

```
1. OIDC convention reserves id_token claims for "identity facts about
   the subject": sub, email, name, picture, auth_time. Not key
   material. workspace_encryption_keys is not a fact about who the
   user is. It is a capability we grant the bearer. Putting it inside
   id_token piggybacks on OIDC's signing infrastructure to deliver
   something that isn't OIDC. The standard works; we just are not
   following it.

2. id_tokens have a different "is this sensitive?" cultural assumption
   than refresh_tokens. Logging middleware, Sentry replays, devtools
   network panels, OIDC-aware analytics, mobile JWT pretty-printers,
   and customer-support pasted console output all routinely treat
   id_tokens as non-sensitive identity data. Persisting one that
   contains encryption keys widens the data-at-rest leakage surface
   compared to /workspace-identity (which only returned the keys in
   an HTTP response body, in memory at sign-in, never persisted).

3. The signature does not earn its keep. The previous spec's own
   JSDoc on `decodeIdTokenClaims` tells the reader: "do not verify
   this signature; TLS already authenticates the issuer and the
   token never leaves this client." A signed envelope only earns its
   keep when a relying party trusts the issuer by signature instead
   of by transport. We are the only consumer of our own id_tokens.

4. The "freshness on every refresh" pitch overstates the problem.
   The previous design solved a specific bug: identity captured once
   at sign-in and never updated. The honest fix is "fetch identity
   when you need it and cache for the session," which is what every
   non-OIDC OAuth API does. It does not require welding identity's
   rotation cadence to access-token rotation cadence.
```

The alternative is not "more clever." It is "less clever." We stop trying to make OAuth 2.1 do OIDC's job. Identity comes from a tiny REST endpoint named after what it returns. Tokens stay tokens.

## The shape

### Wire

```http
POST /auth/oauth2/token
Content-Type: application/x-www-form-urlencoded
grant_type=authorization_code&code=...&code_verifier=...&client_id=...

→ 200 OK
{
  "access_token":  "eyJ...",   // JWT, sub=userId, scope, exp
  "refresh_token": "abc...",   // opaque rotation key
  "expires_in":    3600,
  "token_type":    "bearer"
}
```

If Better Auth still returns `id_token` because `openid` is in the granted scope set, the client discards it. We do not negotiate the field out of the response in this spec; that is a downstream cleanup once we are sure no client cares.

```http
GET /api/me
Authorization: Bearer <access_token>

→ 200 OK
{
  "user": { "id": "...", "email": "..." },
  "encryptionKeys": [
    { "version": 1, "userKeyBase64": "..." },
    { "version": 2, "userKeyBase64": "..." }
  ]
}
```

This is the renamed `/workspace-identity`. Same handler shape, same `resolveBearerIdentity` resolver, same `deriveUserEncryptionKeys` injection. The new path puts it under `/api/*` where every other protected resource lives.

### Persisted on the client

```ts
export const OAuthTokenGrant = type({
  '+': 'delete',
  accessToken:           'string',
  refreshToken:          'string',
  accessTokenExpiresAt:  'number',
});
```

Three fields. Flat. No nesting. No `identity` peer. No `idToken`. Browser localStorage, extension `chrome.storage.local`, and the CLI's `~/.epicenter/auth.json` all validate against this exact arktype.

### Held in memory (not persisted)

```ts
type AuthState =
  | { status: 'signed-out' }
  | { status: 'loading' }                                     // NEW: tokens on disk;
                                                              // /api/me not yet returned
  | { status: 'signed-in';       identity: WorkspaceIdentity }
  | { status: 'reauth-required'; identity: WorkspaceIdentity | null };
                                                              // identity is null when
                                                              // reauth-required happens
                                                              // across process restart
                                                              // (no in-memory cache to
                                                              // preserve "last known good")

type WorkspaceIdentity = { user: { id: string; email: string }; encryptionKeys: EncryptionKeys };
```

The `loading` variant is new vs the id_token spec. There, tokens-present implied identity-present because identity was bundled in the same blob. Here, cold boot reads tokens synchronously, then fires `GET /api/me`; the gap between those two events is a real state worth naming. UIs treat `loading` as "show a spinner; don't render the sign-in form."

`reauth-required.identity` is now `WorkspaceIdentity | null`. Within a running process, it preserves the last known good identity (so the UI can say "Welcome back, alice@example.com, your session expired"). After a process restart with expired refresh_token, in-memory identity is gone and the field is null (the UI says "Your session expired, please sign in again" without a username). This is a minor UX regression vs the id_token spec and we accept it; persisting identity hints to disk would re-introduce the dual-write problem the spec was written to eliminate.

`WorkspaceIdentity` shape is unchanged from today. Provenance changes: `identity` was previously embedded in a persisted `OAuthSession` blob; now it lives only in the running `createOAuthAppAuth` instance's memory. Each fresh process fetches `/api/me` once on the first signed-in transition and caches the result for the lifetime of that instance.

## Trust model (unchanged, stated explicitly)

```
Server derives per-user encryption keys from a server secret.    (unchanged)
Server can decrypt any user's data.                              (unchanged)
Client receives keys via TLS-protected HTTP response body.       (unchanged shape;
                                                                  previously called
                                                                  /workspace-identity)
```

This spec is a packaging cleanup, not a security model change. It is not a stepping stone to zero-knowledge encryption; that is a separate, larger product decision tracked in the previous spec's "Out of scope" section.

## Architecture

### Server side: `apps/api/src/app.ts`

Add a new route:

```ts
import { resolveRequestWorkspaceIdentity } from './auth/resource-boundary';
import { deriveUserEncryptionKeys } from './auth/encryption';
import { createOAuthUnauthorizedResourceResponse } from './auth/oauth-resource';

app.get(
  '/api/me',
  describeRoute({
    description: 'Return the authenticated user and their workspace encryption keys',
    tags: ['auth'],
  }),
  async (c) => {
    const { data: identity, error } = await resolveRequestWorkspaceIdentity(
      c,
      deriveUserEncryptionKeys,
    );
    if (error) return createOAuthUnauthorizedResourceResponse(c, error);
    return c.json(identity);
  },
);
```

`/workspace-identity` stays alive for one release window so existing clients (if any) do not break. The previous spec's Wave 4a env-flagged 503 pattern still applies, with the endpoint flipped from "alive" to "gone" once telemetry says no one calls it.

There is no change to `create-auth.ts`. No `customIdTokenClaims` hook. No new `customAccessTokenClaims` hook. The plugin set stays exactly as it is (jwt + oauthProvider). The ES256 signing already landed; nothing new there.

There is no change to `apps/api/src/auth/resource-boundary.ts`; the `resolveRequestWorkspaceIdentity` helper is the same one `/workspace-identity` already uses. The new `/api/me` route follows the `/workspace-identity` handler pattern (call the resolver directly, which enforces bearer + `workspaces:open` scope internally), not the `/api/health` pattern (`app.use('/api/health', requireOAuthUser)` middleware). Both patterns coexist in `app.ts` today; we use the resolver-direct pattern because we need encryption keys, not just the lean user object.

### Server side: id_token issuance

`@better-auth/oauth-provider` issues an id_token whenever the granted scope set includes `openid`. Today every Epicenter client's scope set includes `openid` (it is in `EPICENTER_TRUSTED_OAUTH_CLIENTS` and re-asserted in the `oauthProvider({ scopes: [...] })` registration). The id_token contains standard OIDC claims (sub, email, iss, aud, exp, iat, optionally name and picture from profile scope) and nothing custom because `customIdTokenClaims` is not configured.

The client ignores the field. This is the cleanest cut: we do not modify scope handling, do not break OIDC discovery, do not need to coordinate a client-and-server scope change across releases. We just stop reading the id_token. Some bandwidth is wasted on every `/oauth2/token` response (~500 bytes for the unused field); negligible compared to the simpler client code and forward-compat headroom.

Future cleanup spec, if we are sure we never want OIDC: drop `openid` from `trustedOAuthScopes` and from the plugin's `scopes` array. Not in this spec.

### Client side: `@epicenter/auth`

The public shape collapses:

```
Before (id_token spec):
  @epicenter/auth/
    auth-types.ts                      OAuthTokenGrant (4 fields) + IdTokenClaims arktype
    decode-id-token.ts                 NEW: ~30 lines; decode + assert
    create-oauth-app-auth.ts           rename sessionStorage -> tokensStorage; derive
                                       identity from decoded id_token; same-user guard
                                       on claims.sub equality
    auth-state-store.ts                identities and keys diffed on token-bundle change
    auth-errors.ts                     gains IdTokenInvalid variant
    node/machine-tokens-store.ts       file backend persists 4 fields

After (this spec):
  @epicenter/auth/
    auth-types.ts                      OAuthTokenGrant (3 fields). WorkspaceIdentity stays.
    create-oauth-app-auth.ts           rename sessionStorage -> tokensStorage; fetch
                                       identity from GET /api/me; same-user guard moves
                                       to identity-fetch step
    auth-state-store.ts                identities diffed when /api/me returns a different user
    node/machine-tokens-store.ts       file backend persists 3 fields
```

Deleted vs the id_token spec:

```
decode-id-token.ts                     never written
IdTokenClaims arktype                  never declared
IdTokenInvalid error variant           never added
the "decode but do not verify" JSDoc comment that documented the footgun
the same-user guard's reliance on claims.sub
the pairwiseSecret load-bearing comment in create-auth.ts (no longer load-bearing)
the customIdTokenClaims hook in create-auth.ts (never added)
the workspace_encryption_keys claim shape
the deriveUserEncryptionKeys parameter on createAuth({ ... })
the spec's V3, V4, V5 verification of jwt() plugin behavior beyond ES256
```

ES256 still earns its keep because the JWT access_token uses it for stateless validation at the resource server. We keep that.

### Lifecycle: sign-in (browser, cold)

```
1. user clicks sign-in                                state: signed-out
2. auth.startSignIn()
     - launcher runs OAuth PKCE flow
     - /auth/oauth2/token returns { access_token, refresh_token, expires_in }
     - tokensStorage.set({ accessToken, refreshToken, accessTokenExpiresAt })
3. state transitions: signed-out -> loading
4. authClient.fetchIdentity()
     - GET /api/me with the new bearer
     - returns { user, encryptionKeys }
     - same-user guard: if a prior identity was cached (e.g., user just
       finished a reauth-required loop), compare prior.user.id to new.user.id;
       on mismatch, drop prior, no guard violation (the new identity wins).
     - store identity in memory
5. state transitions: loading -> signed-in
6. UI unblocks
```

One round-trip after the OAuth dance. The user has just clicked "sign in" and waited for the OAuth redirect; one more `GET` is invisible. Same shape as today's `/workspace-identity` call. Same network cost.

### Lifecycle: cold boot (existing user)

```
1. tokensStorage.get() -> { accessToken, refreshToken, accessTokenExpiresAt }
2. derive initial state:
     - tokens missing                  -> signed-out (end)
     - tokens present                  -> loading
3. fetch /api/me with the access_token
4. resolve final state:
     - 200 + payload                   -> signed-in
     - 401, refresh succeeds, retry 200-> signed-in
     - 401, refresh fails (refresh_token expired or revoked)
                                       -> reauth-required (identity: null)
     - any other failure (network)    -> stay loading; retry policy TBD
                                          (likely: exponential backoff +
                                          surface offline state to UI)
5. UI renders
```

The `loading` sub-state is brief in the happy path: the time between reading tokens and `/api/me` completing. UIs gate on `state.status === 'signed-in'`; in `loading`, they render a neutral spinner, not the sign-in form. On a slow or failing network, `loading` can persist; the consumer decides whether to retry, time out, or surface an offline UI.

### Lifecycle: refresh

```
1. auth.fetch hits a 401
2. force-refresh access_token via /auth/oauth2/token
3. new access_token persists; refresh_token rotates
4. identity STAYS THE SAME in memory; we do NOT re-fetch /api/me
   (token rotation does not change who the user is)
5. retry the original request
```

This is the key simplification vs the id_token design. There, every refresh produced a fresh id_token, which the client decoded and diffed against cached identity, possibly triggering identity-change events. Here, the refresh path touches tokens only. Identity is independent.

The same-user guard does NOT fire on refresh. It fires only on `/api/me` calls, which happen on sign-in and on cold-boot. Refresh is "I am still me; give me a new access_token." Same-user is not in scope.

Mid-session identity changes (email changed in another tab, encryption keys rotated server-side) are not propagated by token refresh. They propagate on the next cold boot or sign-in. This matches user expectation: an email change in another tab does not silently appear in this tab without a page reload.

### Lifecycle: reauth-required

Two flavors, depending on whether the process was running when the refresh failed:

```
In-process reauth (refresh fails during an active session):
  1. /auth/oauth2/token refresh returns 401
  2. state -> reauth-required, identity preserved from memory
     (UI shows "Welcome back alice@example.com, your session expired")
  3. user re-signs-in
  4. new tokens arrive; new /api/me call returns next identity
  5. same-user guard at /api/me response:
       next.user.id === prior.user.id -> state -> signed-in (continuous)
       next.user.id !== prior.user.id -> drop prior identity, treat as
                                          fresh signed-in (this is a user
                                          switch, not a user-swap attack)

Cross-process reauth (cold boot with expired refresh_token):
  1. tokensStorage.get() -> tokens present
  2. state -> loading
  3. /api/me -> 401 -> refresh -> refresh fails
  4. state -> reauth-required, identity = null
     (UI shows "Your session expired, please sign in again" without a name)
  5. user re-signs-in
  6. fresh tokens + /api/me
  7. state -> signed-in (no prior identity to compare against)
```

The same-user guard moves from "compare two id_token decodes on every refresh" to "compare two /api/me responses on sign-in only." Same intent, narrower trigger, simpler to reason about.

### Lifecycle: sign-out

```
1. auth.signOut()
2. POST /auth/oauth2/revoke with refresh_token (RFC 7009)
3. tokensStorage.set(null)
4. identity dropped from memory
5. state -> signed-out
```

### Tab sync

The tokens cell is the only persisted thing. Browser tabs cross-sync via `localStorage` storage events (already done by `createPersistedState`). Each tab decodes the new tokens and fetches its own `/api/me` after receiving the cross-tab change.

In-memory identity is per-tab, never synchronized. This is the same cost-shape as fetching identity once on each cold boot. Two tabs equals two `/api/me` calls per user-session. Negligible.

## Implementation plan

Follows Build, Prove, Remove.

### Wave 1 (server, additive): LANDED + one route to add

Four commits already landed on this branch:

```
feat(api): sign JWTs with ES256 for broadest verifier support
refactor(constants,api): epicenter-cli is a native client with HTTPS callback
feat(api): /auth/cli-callback page for the CLI OOB authorization-code flow
feat(api): /api/health endpoint for bearer-liveness probes
```

One more commit completes Wave 1:

```
feat(api): /api/me endpoint returns user + encryption keys
```

Files to touch:

```
apps/api/src/app.ts        EDIT: register app.get('/api/me', ...) using the
                                 existing resolveRequestWorkspaceIdentity helper
                                 and deriveUserEncryptionKeys.

apps/api/src/auth/resource-boundary.test.ts  (existing) already covers the
                                              resolver shape; no test change
                                              required for the rename.

apps/api/src/api-me.test.ts   NEW: integration test asserting GET /api/me with
                                   a valid scoped bearer returns the identity
                                   payload; 401 without bearer; 403 without
                                   workspaces:open scope.
```

Acceptance: `bun --cwd apps/api run typecheck` clean; `bun --cwd apps/api test` green. Manual curl with a real bearer optional.

`/workspace-identity` stays alive; the new route is purely additive.

### Wave 2 (client schema, one PR): the schema change

```
packages/auth/src/auth-types.ts                EDIT: OAuthTokenGrant drops to 3 fields;
                                                     delete OAuthSession entirely.
packages/auth/src/auth-contract.ts             EDIT: JSDoc on AuthState clarifies
                                                     that identity is in-memory,
                                                     not persisted.
packages/auth/src/auth-state-store.ts          EDIT: state derivation now operates
                                                     on token-presence + in-memory
                                                     identity, not on a bundled blob.
packages/auth/src/create-oauth-app-auth.ts     EDIT: rename sessionStorage ->
                                                     tokensStorage. Replace
                                                     loadIdentity (POST
                                                     /workspace-identity) with
                                                     fetchIdentity (GET /api/me).
                                                     replaceSession's same-user guard
                                                     now diffs identity.user.id from
                                                     the previous /api/me result, not
                                                     from a decoded id_token.
packages/auth/src/auth-errors.ts               EDIT: gains FetchIdentityFailed variant;
                                                     no IdTokenInvalid variant.
packages/auth/src/index.ts                     EDIT: drop OAuthSession export; keep
                                                     OAuthTokenGrant, WorkspaceIdentity,
                                                     AuthClient, AuthState.
packages/auth/src/contract.test.ts             EDIT: cover the new fetch-identity-after-
                                                     sign-in path; cover same-user guard
                                                     after re-sign-in.

packages/auth/src/node/machine-tokens-store.ts NEW (renamed from machine-session-store):
                                                     persists OAuthTokenGrant (3 fields)
                                                     to ~/.epicenter/auth.json with mode
                                                     0o600. Atomic-rename write, corrupt
                                                     blob -> Ok(null) + warn,
                                                     permissions-too-open refused load
                                                     with chmod hint.
packages/auth/src/node/machine-session-store.ts        DELETE
packages/auth/src/node/machine-session-store.test.ts   DELETE
packages/auth/src/node/machine-tokens-store.test.ts    NEW
packages/auth/src/node.ts                              EDIT: export loadMachineTokens,
                                                              saveMachineTokens; drop
                                                              loadMachineSession.
```

Acceptance: `bun --cwd packages/auth typecheck` clean; `bun --cwd packages/auth test` green. Browser apps and CLI will not run yet because their call sites still use the old `sessionStorage` field name; Wave 3 fixes them.

Cross-checks after acceptance:

```
grep -rn 'OAuthSession' packages/ apps/ | grep -v node_modules
# Expect zero matches in packages/auth.

grep -rn 'machine-session-store\|loadMachineSession' packages/ apps/
# Expect zero matches.

grep -rn 'IdTokenClaims\|decodeIdTokenClaims' packages/ apps/
# Expect zero matches. The id_token spec's helper never existed in this design.
```

### Wave 3 (adoption)

Each consumer of `@epicenter/auth` and `@epicenter/auth-svelte`:

```
@epicenter/auth-svelte                  rename sessionStorage -> tokensStorage in
                                        internal config; verify exports.

apps/whispering, dashboard, honeycrisp,
apps/opensidian, zhongwen, fuji         EDIT: rename sessionStorage -> tokensStorage
                                        at the createOAuthAppAuth call site. Verify
                                        the persisted shape matches OAuthTokenGrant
                                        (3 fields). None call /workspace-identity.

apps/tab-manager                        EDIT: same rename; verify the chrome.storage
                                        cell key is local:auth.tokens.

packages/auth/src/node/oob-launcher.ts  NEW per the OOB spec. Persists 3-field tokens
                                        from /oauth2/token response. Does not write
                                        id_token to the file even if Better Auth
                                        returns one.
packages/auth/src/node/oob-launcher.test.ts                       NEW

packages/auth/src/node/machine-auth.ts  REPLACE per the OOB spec. New shape:
                                        loginWithOob, status, logout,
                                        createMachineAuthClient. Identity from
                                        /api/me, not from /workspace-identity, not
                                        from decoded id_token.

packages/cli/src/commands/auth.ts       EDIT: calls loginWithOob, reports identity
                                        summary from the returned WorkspaceIdentity.
```

Acceptance: typecheck + tests at every layer; manual smoke per the OOB spec's Verification Plan (browser smoke on one app; CLI smoke on macOS + headless SSH + Docker).

### Wave 4 (cleanup)

```
4a. Env-flagged 503 on /workspace-identity (one release of soak time).
4b. Delete /workspace-identity route from apps/api/src/app.ts.
4c. If resolveBearerIdentity has no remaining callers after 4b, delete it.
    (resolveBearerUser stays; it is /api/me's dependency and the bearer
     middleware's dependency.)
    Actually: /api/me USES resolveBearerIdentity (because it needs encryption
    keys, not just user). So resolveBearerIdentity stays. resolveBearerUser
    stays too. Both earn their keep.
4d. docs/encryption.md: replace /workspace-identity references with /api/me.
4e. packages/cli/README.md: document `epicenter auth login` and the three-field
    file format.
4f. specs/20260512T111335-post-oauth-audit-remediation.md: prepend "Superseded by
    20260514T120000 + 20260514T200000" notice on Phase 4.
```

## What this spec does NOT do

These are explicit non-goals so the next reviewer does not mistake omission for oversight:

```
Adopt zero-knowledge encryption.    Server still derives and knows all keys.

Move tokens to HttpOnly cookies.    Same-origin-XSS surface unchanged.

Drop the OIDC openid scope.         id_token still issues with standard claims.
                                    Client ignores it. Forward-compat headroom.

Change OAuth ceremony.              PKCE, refresh rotation, revoke unchanged.

Introduce per-user master password
or WebAuthn PRF.                    Zero-knowledge enablers; separate decision.

Add a /api/me/keys endpoint.        Identity and keys bundle in one response.

Add an /api/me/refresh endpoint.    Refresh is the OAuth /token endpoint.
```

## Decisions log

1. **`/api/me` instead of `/workspace-identity`.** Conventional REST naming used by Spotify, Figma, Notion, Twitter, GitHub-variants. Lives under `/api/*` with every other protected resource. Returns user + encryption keys because both are caller-specific; not splitting them avoids an extra round-trip and matches `/v1/account`-style endpoints (Stripe) that include capabilities alongside identity.

2. **Drop id_token from client-side consumption; leave server issuance alone.** Server stays OIDC-compliant for any future federation roadmap. Client persists 3 fields. The ~500 bytes of unused id_token in each `/oauth2/token` response is negligible compared to coordinating a scope-set change across server + every client.

3. **Identity is in-memory, not persisted.** Eliminates the dual-write coupling on refresh, the freshness-skew bug class, and the same-user guard at the storage layer. Trade-off: one `GET /api/me` per cold boot per tab. Verified cheap: same network cost as today's `/workspace-identity` call.

4. **Same-user guard moves to identity-fetch.** When `/api/me` returns a different `user.id` than a prior cached identity (e.g., after re-sign-in following reauth-required), the auth client resets to signed-out before transitioning to signed-in. Catches the user-swap bug class. The previous spec put the guard on `decodeIdTokenClaims(next.idToken).sub === identity.user.id`; same intent, different mechanism.

5. **No refresh-time identity recomputation.** Token refresh is for tokens. Identity is fetched on sign-in and trusted for the session lifetime. Mid-session identity drift (email change, key rotation in another tab) propagates on next cold boot. This matches the behavior of GitHub, Stripe, AWS SSO, Linear, Figma; it is the path of least surprise.

6. **Three-field persistence shape.** Matches GitHub CLI's `auth.json`, AWS SSO's cache files, Codex's pre-id_token shape. Refused: 4-field (idToken peer), nested `{ tokens: {...}, identity: {...} }` (the old `OAuthSession`), version field (clean break, zero users, re-login is the migration), users map (single signed-in account per cell).

7. **Keep JWT access_token signing.** Earns its keep at the resource boundary: `resolveBearerUser` verifies the signature locally and reads `sub` without a database round-trip. This is the design win of JWT access tokens. We keep it.

8. **No `customAccessTokenClaims`.** Tempting to embed email in the access_token so the resource boundary can read it without a DB lookup; resisted because (a) `resolveBearerUser` already does the DB lookup, (b) access_token rides on every request and bloating it has compounding network cost, (c) email change propagation gets harder (every issued access_token is stale on email change). The DB lookup is fast and centralized.

## Open questions

1. **Should the `id_token` field in `/oauth2/token` responses be omitted at the server (a follow-up spec)?** Pro: smaller responses, honest signal that we are not OIDC. Con: scope coordination across every trusted client; loses forward-compat headroom for federation. Recommendation: leave it. Revisit if the bandwidth shows up in metrics.

2. **Is one `/api/me` call per cold-boot per tab a problem at the scale we expect?** No today; flag for revisit if cold-boot p95 latency starts mattering.

3. **Should `/api/me` cache the encryption-keys derivation on the server?** `deriveUserEncryptionKeys` does HKDF, which is fast but not free. If `/api/me` becomes a hot path (e.g., daemons that bounce frequently), a per-userId server-side cache with TTL is a one-file change. Not in this spec; flag for the perf-watch period.

4. **Naming: `/api/me` vs `/api/me/identity` vs splitting `/api/me/profile` and `/api/me/keys`?** Bundling is the recommendation; split if a use case ever wants only one half. Not now.

## Verification targets (Pass 2, against actual sources)

```
V1. Better Auth's /auth/oauth2/token returns access_token + refresh_token
    (+ optional id_token when openid is in scope) per the standard /oauth2
    token-endpoint shape. Verify against node_modules/@better-auth/oauth-provider/dist/index.mjs
    around `createUserTokens` (the same code path the previous spec verified
    at lines 403-447). No code change to that path is required for this spec.

V2. /api/me handler reuses resolveRequestWorkspaceIdentity (apps/api/src/auth/
    resource-boundary.ts:131-139) without modification. Verify by literally
    pointing the new route at the same helper /workspace-identity uses today.

V3. apps/api/src/app.ts route registration is order-independent under Hono's
    SmartRouter for non-overlapping paths. /api/me does not collide with the
    /auth/* catch-all (different prefix). The handler enforces bearer + scope
    internally via resolveRequestWorkspaceIdentity, mirroring the today's
    /workspace-identity pattern (apps/api/src/app.ts:238-252). We deliberately
    do NOT layer app.use('/api/me', requireOAuthUser) on top, because we need
    the resolver's encryption-key derivation path, not requireOAuthUser's lean
    user-only path. The two patterns coexist in app.ts today; this spec keeps
    them both.

V4. The three-field OAuthTokenGrant arktype validates without changes against
    Better Auth's token response payload (the existing fields are
    access_token, refresh_token, expires_in; we already map to camelCase in
    refreshOAuthTokenWithEndpoint at packages/auth/src/create-oauth-app-auth.ts).

V5. resolveBearerIdentity (apps/api/src/auth/resource-boundary.ts:99-114)
    enforces workspaces:open scope. /api/me inherits this requirement.
    Bearer with the wrong scope -> 403 InsufficientScope; without bearer ->
    401 InvalidToken. Same as /workspace-identity today.

V6. Cross-tab sync: the existing createPersistedState over localStorage
    fires storage events that other tabs receive. Each tab independently
    fetches /api/me on cold boot. No new tab-sync logic.
```

## References

Today's bundled shape (rewritten by this spec):

```
packages/auth/src/auth-types.ts:21-37            OAuthTokenGrant (4 fields today)
                                                 + OAuthSession bundle.
packages/auth/src/auth-contract.ts:5-18          AuthState with identity.
packages/auth/src/auth-state-store.ts            notify-on-change pattern.
packages/auth/src/create-oauth-app-auth.ts:110-122  loadIdentity calls
                                                    /workspace-identity.
packages/auth/src/node/machine-auth.ts:298-323   fetchOAuthSession uses
                                                 the dead /auth/get-session.
```

Server side:

```
apps/api/src/app.ts:238-252                      /workspace-identity route (renamed
                                                 to /api/me by this spec; old route
                                                 stays alive until Wave 4).
apps/api/src/auth/resource-boundary.ts:99-114    resolveBearerIdentity stays.
apps/api/src/auth/resource-boundary.ts:131-139   resolveRequestWorkspaceIdentity
                                                 stays.
apps/api/src/auth/create-auth.ts                 unchanged; no customIdTokenClaims.
```

Encryption:

```
packages/encryption/src/keys.ts:11-30            EncryptionKey / EncryptionKeys
                                                 arktype; reused in /api/me JSON.
packages/encryption/src/keys.ts:58-73            encryptionKeysEqual (used by the
                                                 identity-diff in auth-state-store).
```

Predecessor specs:

```
specs/20260514T091255-tokens-only-auth-extract-identity-to-workspace.md
   The WorkspaceIdentityStore-extraction variant; rejected by both this spec
   and its predecessor for over-engineering.

specs/20260514T154500-id-token-bearing-encryption-keys.md
   The id_token-carries-keys design; superseded by this spec. The critique
   of OIDC abuse, leakage surface, and lifecycle coupling is what motivated
   the rewrite.

specs/20260514T160000-execute-id-token-and-oob-cli.md
   The execution plan for the superseded design. Wave 1 of that plan still
   stands (the four landed commits); Waves 2-4 are superseded by this spec.

specs/20260514T120000-machine-auth-oob-clean-break.md
   The OOB CLI flow. Composes with this spec; the only adjustment is that the
   CLI's auth.json file persists 3 fields, not 4.
```

## What this spec deletes vs the id_token spec

```
Spec text  ~600 lines (id_token spec) → ~200 lines (this spec, approximately).
Code       Wave 2-4 deltas roughly halve. No new package, no new arktype, no
           new error variant, no new decode helper, no new server hook, no new
           server-side guard against missing email scope, no new pairwiseSecret
           load-bearing assumption to document, no new V3/V4/V5 ES256-discovery
           verification work.
Mental model One concept: tokens go in storage; identity comes from /api/me.
           No "id_token is the identity surface but do not verify the signature
           because TLS already authenticates the server" rationale to carry.
```

This is what the asymmetric-wins pass looks like in practice: the previous spec gained "zero round-trips after sign-in" and a one-decode-path cohesion claim. This spec accepts one round-trip on cold boot (same as today) and gets a cleaner OIDC story, a smaller persistence shape, and a smaller code surface in return. The "cohesion sentence" still holds because the cohesion was never about the id_token mechanism; it was about "one storage cell, one validator, three storage backends." That survives unchanged.
