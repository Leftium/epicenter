# Online grant, local unlock, profile: three concerns, three lifecycles

**Date**: 2026-05-14 (revised)
**Status**: Proposed (revision 3; supersedes the in-memory-identity draft of revision 2)
**Supersedes**:
- `specs/20260514T154500-id-token-bearing-encryption-keys.md` (the id_token-carries-keys design)
- `specs/20260514T160000-execute-id-token-and-oob-cli.md` (the Wave 1-4 plan based on that design)
- `specs/20260514T091255-tokens-only-auth-extract-identity-to-workspace.md` (the WorkspaceIdentityStore variant)
**Composes with**: `specs/20260514T120000-machine-auth-oob-clean-break.md` (the OOB CLI flow; this spec adjusts the persisted shape the CLI's `~/.epicenter/auth.json` holds)

## One Sentence

```
There are three concerns, not two: an online grant (server access),
a local unlock (offline decryption), and a profile (UI labels).
Each persists where it earns its keep: the grant and the unlock on
disk in one cell with two clearly-labeled sections; the profile
in memory only, fetched from /api/me when online.
```

This is the cohesion sentence. The previous draft tried to split on "tokens vs identity" and broke offline cold-boot. The correct split is on lifecycle and authority, not on the wire shape.

## The journey to this design

Five proposals preceded this one. Listing them as alternatives considered, with the specific failure mode that eliminated each:

```
1. /workspace-identity (status quo)
   identity captured at sign-in, never refreshed
   freshness bug: keys go stale, no recovery path

2. WorkspaceIdentityStore as a second package (spec 20260514T091255)
   adds a parallel store with its own attach/detach lifecycle
   over-engineered; the smell it attacked dissolved at a different layer

3. id_token-bearing encryption keys (spec 20260514T154500)
   identity rides in id_token's claims; one-cell, decode-on-read
   OIDC abuse: keys are capability material, not identity facts
   leakage surface widens: loggers treat id_tokens as non-sensitive
   signature theater: client decodes but does not verify

4. /api/me + in-memory-only identity (revision 2 of THIS spec)
   tokens persist; identity fetched on cold boot
   offline cold-boot breaks: daemon cannot decrypt local Yjs data
   loading-as-failure-mode: long network outage looks like infinite loading

5. /api/me + bundled identity (Option B "charitable")
   tokens and identity in one cell, same shape as today
   freshness fix via cold-boot refresh
   conceptually muddy: bundles "what's needed for the server" with
   "what's needed for offline decrypt" with "what UI shows"
```

This proposal is the response to (5)'s muddiness. The mechanical answer is the same one-cell shape, but the conceptual model is sharper.

## The split

```
ONLINE GRANT
  what:        server access; the bearer for /api/* and the rotation key
  fields:      accessToken, refreshToken, accessTokenExpiresAt
  fetched:     /auth/oauth2/token (sign-in; refresh on 401)
  persisted:   yes (offline-useless, but needed to call the server when online)
  refreshed:   on 401 (auto); rotation invisible to callers
  cleared:     sign-out

LOCAL UNLOCK
  what:        device capability to decrypt local Yjs data without the server
  fields:      userId, encryptionKeys
  fetched:     /api/me (sign-in; cold-boot when online)
  persisted:   yes (offline cold-boot reads this to decrypt)
  refreshed:   /api/me on cold-boot when online; updated only if keys changed
  cleared:     sign-out, OR same-user guard mismatch on next /api/me

PROFILE
  what:        UI display labels for the human (email; future: name, avatar)
  fields:      email
  fetched:     /api/me (sign-in; cold-boot when online)
  persisted:   NO (memory only; cold-boot offline degrades to generic label)
  refreshed:   /api/me on cold-boot when online
  cleared:     sign-out, process exit
```

The asymmetric move: refuse to persist email even though we could. The reason is policy-by-construction, not byte-counting. Drawing the line at "disk holds device capability material, nothing decorative" means future contributors do not face "is this OK to persist?" debates each time a UI feature wants a label cached.

## Persisted shape

```ts
// packages/auth/src/auth-types.ts

export const OAuthTokenGrant = type({
  '+': 'delete',
  accessToken:           'string',
  refreshToken:          'string',
  accessTokenExpiresAt:  'number',
});
export type OAuthTokenGrant = typeof OAuthTokenGrant.infer;

export const LocalUnlockBundle = type({
  '+': 'delete',
  userId:          'string',
  encryptionKeys:  EncryptionKeys,
});
export type LocalUnlockBundle = typeof LocalUnlockBundle.infer;

export const PersistedAuth = type({
  '+': 'delete',
  grant:  OAuthTokenGrant,
  unlock: LocalUnlockBundle,
});
export type PersistedAuth = typeof PersistedAuth.infer;
```

One cell. Two sections. The browser persists this to localStorage; the extension to chrome.storage.local; the CLI to `~/.epicenter/auth.json` (mode 0o600). All three storage cells validate against the same arktype.

`OAuthSession` (today's `{ tokens, identity }`) is deleted; this is a clean break, not a rename.

## Persisted storage contract

```ts
type PersistedAuthStorage = {
  get(): PersistedAuth | null;
  set(value: PersistedAuth | null): void | Promise<void>;
  watch?(fn: (value: PersistedAuth | null) => void): () => void;
};
```

`watch` is optional because the CLI file store has one process owner. Browser and extension stores must provide it:

```
Browser localStorage      createPersistedState.watch
Extension chrome.storage  createStorageState.watch
CLI auth.json             no watch hook
```

`createOAuthAppAuth` treats external storage changes as authoritative. If another tab or extension context clears the cell, this instance clears `grant`, `unlock`, `profile`, and moves to `signed-out`. If another context writes a cell for the same `unlock.userId`, this instance adopts the new grant and unlock, drops profile to `null`, marks profile freshness as `missing`, and runs the online verification path before attaching a bearer again. If another context writes a cell for a different `unlock.userId`, this instance drops profile and forces `signed-out` instead of serving two users in one live runtime.

## Profile is memory-only

```ts
// packages/auth/src/auth-contract.ts (or co-located with createOAuthAppAuth)

type Profile = {
  email: string;
  // Future: name, avatar; everything here is fetched, never persisted.
};
```

There is no `Profile` arktype because we never validate it from disk. It is built from `/api/me` responses and lives inside the running `createOAuthAppAuth` instance.

## AuthState

```ts
type ProfileStatus = 'missing' | 'refreshing' | 'fresh' | 'stale';

type AuthState =
  | { status: 'signed-out' }
  | {
      status: 'signed-in';
      unlock: LocalUnlockBundle;
      profile: Profile | null;
      profileStatus: ProfileStatus;
    }
  | {
      status: 'reauth-required';
      unlock: LocalUnlockBundle;
      profile: Profile | null;
      profileStatus: ProfileStatus;
    };
```

Three variants. `unlock` is always present in `signed-in` and `reauth-required` because we persist it; `profile` is `null` until `/api/me` succeeds at least once. UIs gate on `unlock` for "can I decrypt?" and on `profile?.email` for display. `profileStatus` is the typed home for the freshness bit:

```
missing     no /api/me response has loaded in this runtime
refreshing  /api/me is in flight
fresh       /api/me succeeded for the current unlock/grant epoch
stale       a later /api/me attempt failed after a profile had loaded
```

No `loading` state. Disk reads are synchronous in browsers (localStorage) and fast in Node (`fs.readFile` of a tiny JSON file); the transition from "nothing in memory" to "signed-in" happens in one tick. Offline-and-cannot-unlock would be a degenerate state (unlock cell missing) that we map to `signed-out`, forcing re-auth.

`profileStatus` is not a fourth auth state. It is metadata about the online profile check. Local workspace construction can proceed with `unlock` while `profileStatus` is `missing`; bearer-bearing network calls cannot.

## Network gate

`auth.fetch` and `auth.openWebSocket` only attach a bearer after the current runtime has confirmed `/api/me` for the current persisted cell. The rule:

```
Before attaching Authorization or bearer.<token>:
  1. if profileStatus === 'fresh', continue
  2. if grant is expired or within refresh skew, refresh grant first
  3. call GET /api/me with the fresh-enough access token
  4. if /api/me returns the same userId:
       update unlock if keys changed
       set profile
       profileStatus = 'fresh'
       attach bearer and continue
  5. if /api/me returns a different userId:
       clear persisted cell
       profile = null
       state = signed-out
       do not attach bearer
  6. if /api/me fails for network/server reasons:
       keep unlock for local decrypt
       profileStatus = profile ? 'stale' : 'missing'
       do not attach bearer
```

This is the fix for the sync race. Cold boot can mount encrypted local Yjs data immediately, including offline. Collaboration and API requests wait until the same-user guard has passed in this runtime. If the device is offline, no bearer is attached, so the network path fails closed while local-first data remains usable.

## Server endpoints

```
POST /auth/oauth2/token   standard OAuth 2.1 token response
                          no server-side wrapping
                          { access_token, refresh_token, expires_in,
                            token_type, scope, id_token? }

GET  /api/me              { user: { id, email }, encryptionKeys }
                          single identity refresh point;
                          inherits bearer + workspaces:open from
                          resolveRequestWorkspaceIdentity
```

Two endpoints, both standard. No id_token claim hook. No customAccessTokenClaims. Better Auth may still include `id_token` when `openid` is granted; the client ignores it and never persists it. The `/api/me` route already shipped in commit `9f32ea0bc` and earns its keep in this design as the identity refresh point.

`/workspace-identity` stays alive as a legacy alias until Wave 4 deletes it.

## Lifecycles

### Sign-in (cold)

```
1. user clicks "sign in"
2. OAuth PKCE dance: redirect, consent, code
3. POST /auth/oauth2/token              → { access_token, refresh_token, expires_in }
4. write grant cell                       (3 fields)
5. GET /api/me                          → { user: { id, email }, encryptionKeys }
6. write unlock cell                      (userId + encryptionKeys; NOT email)
7. set memory profile                     (email)
8. same-user guard fires:
   - if prior unlock cell existed AND userId differs, treat as fresh sign-in
     (drop prior memory; new identity wins; old workspace data is unreachable
     because the key derivation differs)
9. state = signed-in
```

Two round-trips on sign-in (token, then me). This is the rare event; the cost is invisible.

### Cold boot

```
1. read persisted cell                    (one file; both sections)
   - cell absent       → state = signed-out (end)
   - cell present      → continue
2. state = signed-in immediately
   (unlock has userId + encryptionKeys; workspace can decrypt local Yjs;
    profile = null and profileStatus = missing at this point;
    UI shows generic account label)
3. if online:
   a. if access_token is stale, refresh the grant first
      (touches grant cell only)
   b. GET /api/me
      success → update unlock cell if encryptionKeys changed;
                set memory profile.email;
                profileStatus = fresh;
                same-user guard: if response.user.id !== unlock.userId,
                  wipe cell, drop profile, state = signed-out (force re-auth)
      failure → keep state = signed-in;
                profileStatus = profile ? stale : missing
4. UI renders
```

Offline cold-boot stops at step 2; data is decryptable; the user can read and write to local Yjs blobs. Reconciliation happens when the device comes online.

### Refresh (on 401 during a fetch)

```
1. auth.fetch hits a 401
2. force-refresh: POST /auth/oauth2/token grant_type=refresh_token
3. response → write grant cell (3 fields)
4. unlock cell untouched
5. profile untouched
6. retry the original request
```

Refresh is purely an online-grant concern. It does not write or read unlock; it does not touch profile.

### Sign-out

```
1. auth.signOut()
2. POST /auth/oauth2/revoke with refresh_token (RFC 7009)
3. clear persisted cell (both sections, atomic)
4. clear memory profile
5. state = signed-out
```

### Reauth-required (refresh fails)

```
1. /auth/oauth2/token refresh returns 401 (refresh_token expired/revoked)
2. state = reauth-required, unlock preserved, profile preserved if loaded
3. UI shows "session expired; signed in as ${profile?.email ?? 'your account'}"
4. user re-signs-in:
   - new tokens arrive; new /api/me call
   - same-user guard at step 5 of sign-in flow handles continuity or swap
```

## Why each field earns its keep

```
grant.accessToken            proves authorization until accessTokenExpiresAt;
                             sent on every /api/* request;
                             ~700 bytes JWT (ES256 + standard claims)

grant.refreshToken           obtains the next accessToken when this one expires;
                             opaque; ~32 bytes; the survival key

grant.accessTokenExpiresAt   skip a refresh round-trip when accessToken is fresh;
                             also signals "you might be offline a while";
                             number

unlock.userId                same-user guard (if /api/me returns different user,
                             this device is now serving a different account);
                             binds encryptionKeys to a subject;
                             string

unlock.encryptionKeys        decrypt local Yjs blobs; the whole reason unlock
                             persists at all;
                             array of { version, userKeyBase64 }

profile.email (memory only)  UI display in account popover, sign-out confirm,
                             share dialogs; absent on cold-boot offline;
                             string
```

What does NOT earn its keep:

```
unlock.validatedAt           a TOFU receipt for "when did /api/me last confirm
                             these keys?"; useful only if we have a policy like
                             "refuse offline decrypt after 30 days unvalidated."
                             We don't have that policy. YAGNI.

email on disk                decorative; not capability material; cold-boot
                             offline UI degrades to "Account" gracefully.
                             Persisting it sets a precedent for caching more
                             profile fields, which is the slippery slope this
                             spec exists to prevent.

id_token                     dead. Federation roadmap is empty; the signed
                             envelope proves nothing TLS hadn't already.

OAuthSession bundle          deleted. The "two concerns, one blob" shape was
                             what caused the freshness bug to begin with.
```

## Same-user guard

The guard fires in two places, both at /api/me response time:

```
Place 1: sign-in completes
  prior unlock cell exists AND response.user.id !== unlock.userId
    → treat as fresh sign-in: drop prior unlock; new unlock wins
    (the user is signing in as a different account on this device;
     prior workspace data is unreachable, which is intentional)

Place 2: cold-boot online refresh
  response.user.id !== unlock.userId
    → wipe persisted cell; drop profile; state = signed-out
    (the persisted unlock is stale OR an attacker injected refresh_token
     for a different user; either way, force re-auth)
```

The guard moved from "compare two id_token decodes" to "compare /api/me response.user.id to cached unlock.userId." Simpler placement, same intent.

## Comparison to alternatives considered

| Concern | id_token spec | C.2 in-memory | Option B bundle | THIS spec |
| --- | --- | --- | --- | --- |
| Offline cold-boot | works (id_token decode) | BREAKS | works | works |
| OIDC abuse | yes (custom claim) | no | no | no |
| Signature theater | yes (no verify) | no | no | no |
| JWT decode dance | yes | no | no | no |
| Persisted cells | 1 | 1 | 1 | 1 (two sections) |
| Persists email | yes (in JWT) | no | yes | no (memory only) |
| Refresh writes identity | yes (every refresh) | n/a | yes (bundled) | no (tokens only) |
| Round-trips on sign-in | 1 | 2 | 1 (today) / 2 (revised) | 2 |
| Same-user guard | sub equality on JWT | n/a | replaceSession | /api/me response |
| AuthState variants | 3 | 4 | 3 | 3 |
| Profile cache slippery slope | mitigated by JWT contract | n/a | not addressed | drawn at unlock |

The 2 round-trips on sign-in (token, then /api/me) are the price of separating the OAuth dance from the identity surface. We pay this because:
- OAuth 2.1's token endpoint has a standard response shape; we do not extend it
- Sign-in is rare; cold-boot online is rarer-still per-user
- Cold-boot offline does not pay this cost at all

## More radical options considered (and rejected)

```
A. Drop OAuth entirely; use Better Auth's email/password endpoints
   rejected: cross-origin bearer issuance is OAuth's actual job;
   whispering.app cannot share session cookies with api.epicenter.so
   in modern browser privacy modes (Safari ITP, Chrome's cookie phaseout).

B. Single long-lived bearer; no refresh
   rejected: short-lived access + rotating refresh is real defense in depth;
   a leaked access token expires in ~1 hour, vs ~30 days for a leaked bearer.

C. Encryption keys derived client-side from the access_token's sub
   rejected: requires the server secret to be on the client (it isn't);
   true zero-knowledge encryption requires a user-typed password or
   WebAuthn PRF; out of scope.

D. Per-workspace data keys; LocalUnlockBundle is a set of receipts
   rejected for THIS spec; promising as a follow-up.
   The receipt shape would be:
     { userId, workspaceId, encryptedWorkspaceDataKey, keyVersion }
   Wins: smaller blast radius per leak; collaboration-ready; honest authority.
   Costs: crypto migration on existing data; encryption layer contract change.
   Defer to a follow-up spec after this lands.

E. Encrypt the persisted cell with a device key
   rejected: device key needs to be retrievable on cold-boot without user
   input, which means storing it... where? OS keychain reintroduces the
   libsecret-on-Linux fragility the OOB spec rejected.
   At-rest encryption is the OS's job (FileVault, BitLocker, LUKS).

F. Wrap /auth/oauth2/token to inline identity in the response
   rejected: extending OAuth's wire shape ties the auth client to a
   non-standard token endpoint; the round-trip saved on sign-in is rare
   and invisible; the standardness we keep is valuable.

G. Persist email "in case we want offline UI to show it"
   rejected: the slippery-slope concern is real (avatar next, then
   recent workspaces, then theme preferences); the UX cost of "Account"
   vs "alice@..." on cold-boot offline is minor.

H. Persist unlock.validatedAt for future TOFU policy
   rejected: YAGNI; add the field when the policy lands.
```

## Architecture and files to touch

### Server side (already landed except Wave 4)

```
LANDED (Wave 1):
  apps/api/src/auth/create-auth.ts                ES256 jwt() configuration
  apps/api/src/auth-pages/cli-callback-page.tsx   OOB callback page
  apps/api/src/auth-pages/scripts/cli-callback.ts page script
  apps/api/src/auth-pages/styles.ts               .code-block CSS
  apps/api/src/auth-pages/index.tsx               renderCliCallbackPage export
  apps/api/src/app.ts                             /auth/cli-callback route,
                                                  /api/me route,
                                                  /api/health route,
                                                  legacy /workspace-identity alias
  packages/constants/src/oauth.ts                 epicenter-cli runtime: native,
                                                  HTTPS callback redirect
  apps/api/src/auth/trusted-oauth-clients.ts      toOAuthClientType two-arm switch
  apps/api/src/api-me.test.ts                     /api/me boundary tests
  apps/api/src/auth-pages/cli-callback-page.test.ts callback page tests
  apps/api/src/health.test.ts                     /api/health tests

WAVE 4 (cleanup):
  apps/api/src/app.ts                             delete /workspace-identity route
                                                  after one release of soak time
```

### Client side (Wave 2)

```
packages/auth/src/auth-types.ts                   EDIT
  - keep OAuthTokenGrant (already 3 fields)
  - NEW: LocalUnlockBundle arktype (userId + encryptionKeys)
  - NEW: PersistedAuth arktype (grant + unlock)
  - DELETE: OAuthSession entirely

packages/auth/src/auth-contract.ts                EDIT
  - AuthState gains 'signed-in' and 'reauth-required' carrying
    { unlock: LocalUnlockBundle; profile: Profile | null; profileStatus }
  - add Profile and ProfileStatus public types
  - DELETE WorkspaceIdentity from the public AuthState surface
    (it stays internal as a helper type for /api/me responses)

packages/auth/src/auth-state-store.ts             EDIT
  - state derivation operates on (cellPresent, profile, profileStatus)
  - state-change events fire on profile load and on unlock change

packages/auth/src/create-oauth-app-auth.ts        EDIT (significant rewrite)
  - rename config field: sessionStorage -> persistedAuthStorage
  - one storage adapter; reads/writes PersistedAuth shape
  - persistedAuthStorage.watch is optional; browser/extension call sites must
    pass it through so cross-tab sign-out and same-user guard wipes propagate
  - fetchProfile(): GET /api/me, returns { user, encryptionKeys }
  - same-user guard at fetchProfile response time
  - auth.fetch/openWebSocket refresh expired grants before fetchProfile and do
    not attach a bearer until profileStatus is fresh for the current cell
  - refresh path writes only the grant section
  - sign-in path writes the cell atomically (both sections)

packages/auth/src/auth-errors.ts                  EDIT
  - add FetchProfileFailed variant (non-fatal in offline cold-boot)
  - keep StartSignInFailed, SignOutFailed

packages/auth/src/require-identity.ts             EDIT
  - DELETE; consumers should reach for state.unlock or state.profile
    directly per their need

packages/auth/src/require-session.ts              EDIT (or delete)
  - re-evaluate; today bundles identity + transport methods
  - if kept, becomes "ensure unlock present; return unlock + transport"

packages/auth/src/index.ts                        EDIT
  - drop OAuthSession and WorkspaceIdentity exports
  - add LocalUnlockBundle, Profile, PersistedAuth
  - drop requireIdentity export (if deleted)

packages/auth/src/contract.test.ts                EDIT
  - cover three-state machine
  - cover sign-in writes both sections
  - cover refresh writes only grant
  - cover cold-boot signed-in with profile=null
  - cover same-user guard on /api/me response
  - cover storage watch: external clear signs out this runtime
  - cover network gate: cold boot can expose unlock immediately, but fetch and
    openWebSocket do not attach a bearer until /api/me confirms same user
  - cover expired grant ordering: refresh grant before first /api/me
  - cover profileStatus missing/fresh/stale transitions

packages/auth/src/node/machine-tokens-store.ts    NEW (renamed from machine-session-store)
  - persists PersistedAuth (grant + unlock; no profile)
  - file path: ~/.epicenter/auth.json mode 0o600
  - atomic write via .tmp + rename
  - corrupt-blob -> Ok(null) + warn
  - permissions-too-open -> refuse load with chmod hint
  - MachineAuthStorageError defined here

packages/auth/src/node/machine-session-store.ts   DELETE
packages/auth/src/node/machine-session-store.test.ts  DELETE
packages/auth/src/node/machine-tokens-store.test.ts  NEW
packages/auth/src/node.ts                         EDIT
  - export loadMachineTokens, saveMachineTokens
  - drop loadMachineSession, saveMachineSession
```

### Wave 3 (consumer adoption)

```
packages/auth-svelte                              rename config field;
                                                  verify exports

apps/whispering, dashboard, honeycrisp,
apps/opensidian, zhongwen, fuji                   rename sessionStorage ->
                                                  persistedAuthStorage at the
                                                  createOAuthAppAuth call site;
                                                  verify persisted shape

apps/tab-manager                                  same rename; chrome.storage
                                                  cell key migrates to
                                                  local:auth.persisted

packages/auth/src/node/oob-launcher.ts            NEW per OOB spec
                                                  returns OAuthTokenGrant
                                                  (caller pairs with /api/me
                                                   to fetch unlock + profile)
packages/auth/src/node/oob-launcher.test.ts       NEW
packages/auth/src/node/machine-auth.ts            REPLACE per OOB spec
  - loginWithOob: tokens + /api/me; write grant + unlock
  - status: load cell; ping /api/health; decode profile from /api/me on demand
  - logout: revoke + clear cell
  - createMachineAuthClient: load cell; build createOAuthAppAuth
packages/cli/src/commands/auth.ts                 EDIT
  - call loginWithOob; report identity summary
```

### Wave 4 (cleanup)

```
apps/api/src/app.ts                               delete /workspace-identity
                                                  after env-flagged 503 soak
apps/api/src/auth/resource-boundary.ts            keep resolveBearerIdentity
                                                  (used by /api/me)
docs/encryption.md                                update /workspace-identity
                                                  references to /api/me
packages/cli/README.md                            document OOB flow + auth.json
specs/20260512T111335-post-oauth-audit-remediation.md
                                                  prepend "superseded by ..."
                                                  notice on Phase 4
```

## Migration

Clean break, same as the prior specs. Pre-launch product; zero existing users; the migration is one forced sign-in per tester.

Storage cell keys are renamed so old `OAuthSession`-shaped data does not accidentally validate against the new arktype:

```
Browser localStorage:    <app>.auth.session   -> <app>.auth.persisted
Extension chrome.storage:           auth.session  -> auth.persisted
CLI file path:           keychain (deleted)    -> ~/.epicenter/auth.json
```

Old keys are ignored. The new `PersistedAuth` arktype refuses to parse `OAuthSession`-shaped blobs (the field names do not match: `tokens` vs `grant`, `identity` vs `unlock`).

## Verification targets

```
V1. resolveRequestWorkspaceIdentity at apps/api/src/auth/resource-boundary.ts:131-139
    enforces bearer + workspaces:open scope and returns { user, encryptionKeys }.
    Wired in app.ts:248-262 for /api/me; verified by apps/api/src/api-me.test.ts.

V2. PersistedAuth arktype validates against the actual shape written by
    createOAuthAppAuth on sign-in. Test: round-trip a sign-in token response
    + /api/me response into the persisted shape; assert arktype accepts it.

V3. Refresh path writes ONLY grant. Test: pre-write a PersistedAuth cell;
    force a refresh; assert unlock.encryptionKeys is byte-identical before
    and after.

V4. Cold-boot offline: pre-write a cell; stub fetch to throw; assert
    state transitions to signed-in (not signed-out, not stuck-loading) with
    unlock present, profile null.

V5. Same-user guard: pre-write a cell with userId=alice; stub /api/me to
    return userId=bob; assert cell is wiped and state = signed-out.

V6. OAuth /token endpoint is unchanged; standard response shape.
    Test against node_modules/@better-auth/oauth-provider/dist/index.mjs:403
    (the createUserTokens response). id_token may be present when openid is
    granted; clients ignore and never persist it.

V7. Network gate: pre-write a cell; construct auth; assert state exposes
    unlock immediately with profileStatus=missing; call auth.fetch and assert
    /api/me is called before the protected request, and the protected request
    receives Authorization only after /api/me returns matching userId.

V8. Expired grant ordering: pre-write an expired accessToken with a valid
    refreshToken; construct auth; trigger auth.fetch; assert refresh writes only
    grant before /api/me is called.

V9. Cross-context storage: create storage with watch; construct auth; emit an
    external null write; assert state becomes signed-out and profile is cleared.

V10. Profile freshness: /api/me failure on cold boot leaves unlock present,
     profile null, profileStatus=missing, and no bearer attached to network
     requests; a later successful /api/me sets profileStatus=fresh.
```

## Open questions

1. **Should `LocalUnlockBundle.validatedAt` be added preemptively for a future TOFU policy?** Recommendation: no. Add when the policy lands. Adding it now invites premature decisions about "how stale is too stale."

2. **Should sign-in be one round-trip via a server-wrapped /token endpoint?** Recommendation: no. The standardness of OAuth /token is worth preserving. Two round-trips on the rare sign-in event is invisible.

3. **Should we delete `requireIdentity` and `requireSession` helpers?** Today they bundle identity-presence checks. With the three-concern split, consumers asking for "the user's keys" should reach for `state.unlock.encryptionKeys` directly; consumers asking for email should reach for `state.profile?.email`. Recommendation: delete both; let consumers compose what they need.

4. **Where does `WorkspaceIdentity` live now?** It is no longer a top-level domain concept. The shape `{ user, encryptionKeys }` is a `/api/me` response type, internal to the auth package. Recommendation: keep it as `ApiMeResponse` (or similar) inside `create-oauth-app-auth.ts`; do not export.

5. **Per-workspace unlock receipts (option D above): when?** When the first collaboration feature ships, or when the encryption layer's blast radius becomes a measurable concern. Track as a separate spec.

The Wave 2 blockers from the fresh-eyes pass are now resolved in the spec body: `PersistedAuthStorage.watch`, `profileStatus`, refresh-before-profile-fetch, and the network gate are part of the required implementation and verification targets.

## Decisions log

1. **Three concerns, three lifecycles, two persistence locations (disk + memory).** Rejects bundling identity into either tokens (id_token spec) or a single "session" blob (OAuthSession). The split is on lifecycle (does this survive a process restart? does this survive going offline?) and authority (do we trust this without re-validation?).

2. **One persistence cell, two sections (`grant` + `unlock`).** Rejects two separate files. Filesystem-level separation buys nothing the type can't express; two files invite desync.

3. **Email is memory-only.** Rejects persisting profile for offline UI. The slippery slope concern is real and the UX regression is minor (one rare event, "Account" instead of an email).

4. **`unlock.validatedAt` is not persisted.** YAGNI until we have a policy that consumes it.

5. **Same-user guard at /api/me response, not at storage write.** Moves the check to the place where actual user identity is known. The storage layer is no longer in the authority business.

6. **Refresh writes only the grant section.** Decouples token rotation from identity. Identity is refreshed only on cold-boot and on sign-in.

7. **AuthState has three variants, not four or six.** No `loading` (disk reads are fast). No `signed-in-offline` (derived from `profileStatus`). No `locked-offline` (degenerate; map to signed-out). The state machine carries authority; profile freshness carries connectivity.

8. **`/api/me` endpoint is kept.** Already shipped; central to the cold-boot refresh path; OAuth /token stays standard.

9. **No id_token consumption client-side.** Server may still issue id_tokens (Better Auth includes them when `openid` scope is granted) but the client never reads them. The bandwidth waste is negligible; forward-compat headroom for federation is preserved.

10. **`requireIdentity` and `requireSession` are deleted.** Their existence assumed identity was one thing; the three-concern split makes them misleading. Consumers reach for the slot they need.

11. **Browser and extension auth storage must be watched by the auth core.** Cross-tab sign-out, token rotation, and same-user guard wipes are not merely storage details. `createOAuthAppAuth` subscribes where the storage backend can watch and treats external changes as authoritative.

12. **Local unlock is immediate; bearer-bearing network waits for `/api/me`.** This preserves offline cold boot without allowing collaboration or protected API calls before the same-user guard has passed. If `/api/me` cannot be reached, local data remains usable and network fails closed.

13. **Cold boot refreshes stale grants before fetching profile.** `/api/me` is protected by the access token, so an expired access token must be repaired before the identity refresh can be trusted.

14. **Profile freshness is public state.** `profileStatus` replaces the vague `lastFetchFailed` prose. UI and session code can tell "no profile yet" from "profile loaded and later went stale" without inventing ad hoc flags.

15. **Different-user sign-in replaces the local unlock in pre-launch builds.** Today `replaceSession` throws on a user mismatch. This spec deliberately changes sign-in to let a new account win, which can orphan the prior account's local encrypted blobs on that device. That is acceptable while there are no launched users; reviewers should see this called out in the Wave 2 commit message.

## References

```
Server side (already landed):
  apps/api/src/app.ts:240-294                    /api/me + legacy alias routes
  apps/api/src/auth/create-auth.ts               ES256 jwt config
  apps/api/src/auth/resource-boundary.ts:99-139  resolveBearerIdentity helpers
  apps/api/src/auth/encryption.ts                deriveUserEncryptionKeys

Client side (to be rewritten):
  packages/auth/src/auth-types.ts                OAuthTokenGrant kept; OAuthSession deleted
  packages/auth/src/auth-contract.ts             AuthState union rewritten
  packages/auth/src/create-oauth-app-auth.ts     storage rename + fetchProfile + guards
  packages/auth/src/auth-state-store.ts          state-change semantics
  packages/auth/src/node/machine-session-store.ts -> machine-tokens-store.ts
  packages/auth/src/require-identity.ts          DELETE
  packages/auth/src/require-session.ts           DELETE or rewrite

Better Auth plugin (unchanged):
  node_modules/@better-auth/oauth-provider/dist/index.mjs:403-447
    createUserTokens - the standard /oauth2/token response we consume as-is

Encryption (unchanged):
  packages/encryption/src/keys.ts                EncryptionKey / EncryptionKeys

Predecessor specs:
  specs/20260514T091255-tokens-only-auth-extract-identity-to-workspace.md (superseded)
  specs/20260514T154500-id-token-bearing-encryption-keys.md              (superseded)
  specs/20260514T160000-execute-id-token-and-oob-cli.md                   (superseded)
  specs/20260514T120000-machine-auth-oob-clean-break.md                   (composes)
```

## Done when (spec is watertight)

```
[x] Three concerns named (online grant / local unlock / profile)
[x] Persistence shape defined: one cell, two sections
[x] AuthState defined: three variants, unlock always present in signed-in
[x] Lifecycle prose covers sign-in, cold-boot online/offline, refresh, sign-out, reauth-required
[x] Each persisted field has a "why is this here?" justification
[x] Alternatives considered include the radical ones (drop OAuth, per-workspace keys, etc.)
[x] Same-user guard placement is explicit
[x] Migration is documented as a clean break with key renames
[x] Verification targets reference real file:line locations
[x] Open questions are listed (fresh-eyes blockers resolved into spec body)
[ ] Reviewed by Braden; product UX cost on cold-boot offline accepted
[x] No em or en dashes in spec body (verified by grep)
```

After Braden sign-off, this spec moves from Proposed to Accepted and Wave 2 begins.
