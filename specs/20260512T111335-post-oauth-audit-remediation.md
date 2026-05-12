# Post-OAuth Audit Remediation

**Date**: 2026-05-12
**Status**: Draft
**Branch**: `codex/auth-bearer-omit-cookies`
**Depends on**: `specs/20260511T150000-final-oauth-auth-architecture.md`, `specs/20260512T100428-app-side-oauth-migration.md`
**Stack Map**: `specs/20260512T134603-auth-spec-stack-clean-break-map.md`
**Stack Position**: Immediate invariant patch after app migration.

## One Sentence

Keep same-user local workspaces alive during temporary network auth failure, and require every network resource to prove the OAuth scope it uses.

This is the cohesion test for the spec. Anything that does not protect local workspace lifetime or seal the OAuth resource boundary belongs in a sibling cleanup spec.

## Execution Shape

This is an invariant patch, not a general auth refactor.

```txt
LOCAL PLANE
  same-user workspace state stays mounted during reauth-required

NETWORK PLANE
  each protected HTTP and WebSocket resource verifies a scoped OAuth token

DRIFT PLANE
  clients call routes and auth surfaces that still exist
```

Do the work in this order when possible:

1. Seal the server resource boundary.
2. Fix route drift that blocks sync.
3. Preserve same-user local workspace lifetime during `reauth-required`.
4. Pick the machine auth path.
5. Tighten WebSocket normalization.
6. Polish callback and extension durability.

Refuse broad cleanup inside this spec. Billing, deployable split, token storage naming, and API middleware diet are sibling work unless a failing test proves they block one of the invariants above.

## Overview

The OAuth migration moved apps onto `auth.startSignIn`, `auth.fetch`, and `auth.openWebSocket`. That boundary is still the right shape, but the audit found five correctness gaps around it: protected routes verify token validity without enforcing resource scope, machine auth still calls removed server endpoints, `reauth-required` destroys local workspaces, some child document sync clients call `/docs/*` while the API serves `/documents/*`, and WebSocket bearer normalization is not finished.

This spec fixes those gaps first. WebSocket origin checks, callback polish, extension launch durability, API middleware cleanup, and billing are included only when they directly affect the same auth boundary.

## Motivation

### Current State

`AuthClient` is intentionally small. Apps do not read raw tokens; they consume auth-owned capabilities.

```ts
type AuthClient = {
	state: AuthState;
	startSignIn(input?: { returnTo?: string }): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
};
```

`reauth-required` preserves identity and encryption keys:

```ts
type AuthState =
	| { status: 'signed-in'; identity: WorkspaceIdentity }
	| { status: 'reauth-required'; identity: WorkspaceIdentity }
	| { status: 'signed-out' };
```

But `packages/svelte-utils/src/session.svelte.ts` currently treats every non-signed-in state as a teardown signal:

```ts
if (state.status !== 'signed-in') {
	if (signedIn) {
		signedIn[Symbol.dispose]();
		signedIn = undefined;
	}
	return;
}
```

The API has two OAuth token verification paths:

```ts
// /workspace-identity
if (!hasScope(payload, WORKSPACES_OPEN_SCOPE)) {
	return { status: 'insufficient_scope', requiredScope: WORKSPACES_OPEN_SCOPE };
}

// protected resource middleware
const result = await resolveOAuthPrincipal({ ... });
if (result.status !== 'resolved') {
	return createOAuthUnauthorizedResourceResponse(c);
}
```

The first path checks `workspaces:open`; the second path only proves issuer, audience, and user existence. That second path guards `/ai/*`, `/workspaces/*`, `/documents/*`, `/api/billing/*`, and authed asset routes.

Machine auth also still calls endpoints removed by the OAuth cleanup:

```ts
plugins: [deviceAuthorizationClient()];
await authClient.deviceCode({ client_id: EPICENTER_CLI_OAUTH_CLIENT_ID });
await authClient.getSession({
	fetchOptions: {
		headers: { Authorization: `Bearer ${tokens.accessToken}` },
	},
});
```

The current server config installs `jwt()` and `oauthProvider()`, not `deviceAuthorization()` or `customSession()`.

Finally, Fuji and Honeycrisp child document sync still use `/docs/*`:

```ts
url: toWsUrl(`${APP_URLS.API}/docs/${ydoc.guid}`);
```

The API route is `/documents/:document`:

```ts
app.use('/documents/*', requireOAuthUser);
app.get('/documents/:document', ...);
```

### Problems

1. **Scope is checked at boot, not at resource use**: A token can pass protected resource middleware without `workspaces:open` as long as it has the right issuer, audience, and subject.
2. **Machine auth is stale**: CLI login still depends on device and session endpoints that the live server no longer exposes.
3. **Local-first fallback is broken**: A refresh failure preserves identity in auth state but destroys the workspace that could use local IndexedDB data.
4. **Child document sync points at a dead route**: Rich-text child docs in Fuji and Honeycrisp can reconnect forever against `/docs/*`.
5. **WebSocket credential handling is only partly normalized**: `singleCredential` lifts the bearer subprotocol into `Authorization`, but the forwarded request can still carry the raw `bearer.*` entry.

### Desired State

```txt
OAuthSession
  user + encryptionKeys
  access token
  refresh token
        |
        v
AuthClient
  state
  fetch()
  openWebSocket()
        |
        v
Resource boundary
  verify issuer
  verify audience
  verify required scope
  derive or load only what the route needs
```

`reauth-required` means local identity still exists and network auth needs repair. It must not mean signed out.

## Research Findings

### Better Auth

DeepWiki against `better-auth/better-auth` confirmed three points that matter here:

| Question | Finding | Spec impact |
| --- | --- | --- |
| Does `verifyAccessToken` enforce scopes automatically? | No. Scopes are enforced when the caller passes `opts.scopes`. | `resolveOAuthPrincipal` must request the required scope, or it must do an equivalent local scope check. |
| Does the OAuth provider expose refresh-token revocation? | Yes. The OAuth provider exposes `/oauth2/revoke`; revoking a refresh token also removes access tokens granted from it. | Machine logout should call the OAuth revoke endpoint instead of Better Auth `signOut` with a bearer header. |
| Are `/auth/device/code` and `/auth/device/token` always present? | No. They come from the separate device authorization plugin. | Machine login cannot call those endpoints unless the server installs that plugin again. |

Local installed source also shows `verifyAccessToken` checks `opts.scopes` only when provided in `node_modules/@better-auth/core/src/oauth2/verify.ts`.

### Cloudflare Workers and Hono

DeepWiki did not provide a definitive upstream rule for every WebSocket edge detail. It did confirm the shape that matters for this spec: validate before proxying to Durable Objects when possible, and avoid treating CORS middleware as WebSocket protection. The exact header-rewrite behavior should be proven with local tests around `singleCredential` and the Durable Object request path.

Decision class: local evidence plus design coherence, not upstream law.

### Yjs, y-indexeddb, and y-protocols

DeepWiki confirmed that keeping an existing `Y.Doc` mounted during network unavailability is sound. Yjs updates are designed for offline operation, IndexedDB persistence stores local updates, and sync providers can reconnect later with state-vector based catch-up.

The spec must still call out application-level pitfalls:

- Do not accept unauthenticated remote writes while local auth is broken.
- Distinguish IndexedDB loaded state from remote synced state.
- Reconnect sync with a fresh auth-owned WebSocket after auth repair.
- Do not destroy and recreate local docs just because network auth temporarily failed.

### SvelteKit and WXT

DeepWiki confirmed the general SvelteKit pattern: redirect only after an auth decision is known. These apps are static browser clients, so the local rule is the browser equivalent: do not navigate away from the callback page until `auth.state.status === 'signed-in'`. DeepWiki did not answer the WXT sidepanel versus background ownership question conclusively. Treat extension launch ownership as a design question to resolve with local WXT code and manual smoke tests, not as a fact from upstream docs.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Keep `AuthClient` as the app boundary | 2 coherence | Keep | The leak is around resource checks and lifecycle handling, not the public app contract. |
| Treat `reauth-required` as local-usable | 1 evidence, 2 coherence | Keep workspace payload mounted for the same user | Auth deliberately preserves identity and encryption keys. Yjs and IndexedDB support local work while offline. |
| Enforce `workspaces:open` on current protected resources | 1 evidence | Pass `scopes: [WORKSPACES_OPEN_SCOPE]` to token verification or keep one equivalent canonical check | Better Auth only enforces scopes when asked. `/workspace-identity` already treats this scope as required. |
| Replace or restore machine login deliberately | 1 evidence | Choose one path before claiming CLI auth works | Device endpoints are absent unless the server installs the device plugin. `/auth/get-session` no longer returns workspace identity. |
| Change `/docs/*` child sync clients to `/documents/*` | 1 evidence | Update Fuji and Honeycrisp immediately | The API route is `/documents/:document`; `/docs/*` is dead. |
| Strip bearer WebSocket subprotocol after normalization | 2 coherence | Consume bearer once at the edge | `singleCredential` promises one canonical credential. Raw bearer material should not be forwarded beyond the resource edge. |
| Do not add a static WebSocket `Origin` allowlist for bearer sync | 2 coherence, local evidence | Remove the helper idea | Sync is an OAuth protected resource. A valid scoped bearer token, not membership in the first-party `TRUSTED_ORIGINS` list, is the resource boundary. Unauthenticated upgrade load belongs to platform rate limits. |
| Defer billing remediation | 3 taste under constraint | Sibling spec | Billing issues are real, but they do not serve the one-sentence auth thesis. |
| Defer API middleware diet | 3 taste under constraint | Sibling spec | Route partitioning is useful but broad. Mixing it with auth fixes raises route-order risk. |

## Relationship To Adjacent Specs

| Source | Relationship | Conflict? |
| --- | --- | --- |
| `specs/20260511T150000-final-oauth-auth-architecture.md` | This spec enforces the same `AuthClient` boundary, `/workspace-identity`, `workspaces:open`, and `auth.openWebSocket` direction. | No. It is a follow-up hardening pass. |
| `specs/20260512T100428-app-side-oauth-migration.md` | That spec migrates apps onto OAuth. This spec fixes the audit gaps left after the migration. | No. It sharpens its `reauth-required` note. |
| `specs/20260512T114350-auth-token-capability-boundary.md` | That untracked sibling spec improves token vocabulary and storage ownership. This spec does not need that refactor to seal scope checks or preserve local lifetime. | No, but order matters. Run this invariant patch first unless the token shape refactor is already in flight. |
| `specs/20260504T233223-sign-out-preserves-local-data.md` | That spec says sign-out destroys the live workspace but preserves owner-scoped persisted data. This spec says same-user `reauth-required` keeps the live workspace mounted. | No. Sign-out is account exit; `reauth-required` is network repair for the same user. |
| `docs/encryption.md` | The doc still describes older names in places, including `/auth/get-session` and `bearerToken`. The current architecture moved identity to `/workspace-identity` and transport to `auth.openWebSocket`. | Documentation drift, not a design conflict. |

## Architecture

### Auth State and Workspace Lifetime

```txt
signed-out
  no identity
  no workspace payload

signed-in
  identity exists
  network auth can be used
  workspace payload is mounted
  sync may connect

reauth-required
  identity exists
  encryption keys exist
  workspace payload stays mounted
  sync is paused, failed, or reconnecting
  UI offers repair without hiding local data
```

The disposal rule is simple: dispose on signed out or different user, not on same-user network auth failure.

Expected session shape (as originally proposed by this remediation):

```ts
type Session<TSignedIn> =
	| { status: 'signed-out' }
	| { status: 'signed-in'; signedIn: TSignedIn }
	| {
			status: 'reauth-required';
			identity: WorkspaceIdentity;
			signedIn: TSignedIn;
	  };
```

> **Superseded.** `specs/20260512T220000-session-two-axis-cohesive-reshape.md`
> collapsed this three-state discriminator to `SessionPayload<T> | null` (no
> discriminant field) and pushed credential freshness back to `auth.state`.
> The runtime invariant (same-user `reauth-required` keeps local workspace
> mounted) is the same; the shape that delivers it changed. The current code
> in `packages/svelte-utils/src/session.svelte.ts` follows the nullable shape.

### Protected Resource Check

```txt
Request
  Authorization: Bearer access_token
        |
        v
singleCredential
  rejects ambiguous credentials
  lifts WS bearer into Authorization
        |
        v
resolveOAuthPrincipal
  parse bearer
  verify issuer
  verify audience
  verify required scope
  load user
        |
        v
route handler
  sees c.var.user
```

### WebSocket Credential Flow

```txt
Client
  sec-websocket-protocol: epicenter, bearer.ACCESS_TOKEN
        |
        v
Worker middleware
  reject duplicate credentials
  set Authorization: Bearer ACCESS_TOKEN
  strip bearer.ACCESS_TOKEN from sec-websocket-protocol
        |
        v
Durable Object
  sec-websocket-protocol: epicenter
```

## Implementation Plan

The phases below are ordered patches, not parallel feature tracks. Do not start with token storage renaming, billing, deployable split, or API route diet. Start where the product invariant is already broken.

| Order | Patch | Why this order |
| --- | --- | --- |
| 1 | Protected resource scopes | Smallest revert-safe security fix. |
| 2 | `/docs/*` route drift | Obvious dead route that blocks child sync. |
| 3 | `reauth-required` lifetime | Preserves the local-first promise after the server boundary is sealed. |
| 4 | Machine auth | Requires a product decision before code churn. |
| 5 | WebSocket normalization | Same resource boundary, but higher handshake edge-case risk. |
| 6 | Callback and extension durability | Important polish after the core invariant is true. |

### Phase 0: Freeze Scope and Protect Existing Work

- [ ] **0.1** Confirm `apps/epicenter` does not exist in this checkout. If a task mentions it, resolve whether it means current `apps/api`, the target composable `apps/server` host with its `cloud-apps/` subtree (see `specs/20260512T150000-cloud-modules-and-networks.md`), or a new planned app before editing. There is no separate `apps/cloud` deployable in the target.
- [ ] **0.2** Preserve existing uncommitted work in `apps/api/src/app.ts`, `apps/dashboard/src/routes/+layout.svelte`, and app layout files. Do not rewrite those changes blindly.
- [ ] **0.3** Update this spec with the exact machine-auth decision before implementing machine auth.

### Phase 1: Seal Current Resource Routes

- [ ] **1.1** Update `resolveOAuthPrincipal` to require `workspaces:open` for the currently mounted protected routes.
- [ ] **1.2** Prefer Better Auth verifier scope support if it matches local tests:

```ts
await verifyOAuthAccessToken(accessToken, {
	verifyOptions: { audience, issuer },
	jwksUrl,
	scopes: [WORKSPACES_OPEN_SCOPE],
});
```

- [ ] **1.3** Return `insufficient_scope` distinctly enough that HTTP routes can answer 403 and WebSocket routes can close with a scoped auth error.
- [ ] **1.4** Add focused tests for valid scoped token, missing scope, wrong audience, wrong issuer, malformed bearer input, and missing user.
- [ ] **1.5** Remove the misleading `resolveOAuthPrincipal` comment that says protected resources do not need the scope check.

### Phase 2: Fix Dead Sync Routes

- [x] **2.1** Change Fuji child document sync from `/docs/${ydoc.guid}` to `/documents/${ydoc.guid}`.
- [x] **2.2** Change Honeycrisp child document sync from `/docs/${ydoc.guid}` to `/documents/${ydoc.guid}`.
- [ ] **2.3** Add a tiny route helper only if it removes repeated route literals without hiding intent.
- [ ] **2.4** Add or update tests where the app already tests sync URL construction. If no suitable test seam exists, add a narrow unit around the helper rather than broad component tests.

### Phase 3: Preserve Local Workspaces During Reauth

> **Superseded by `specs/20260512T220000-session-two-axis-cohesive-reshape.md`.**
> That spec reshapes `Session<T>` to `SessionPayload<T> | null` (collapsing the
> three-state discriminator), renames `requireSignedIn` to `requireIdentity`,
> renames each app's `getSignedInSession` to `requireWorkspace`, and lands the
> same `reauth-required` workspace preservation invariant via one final
> migration pass instead of the hybrid shape proposed here. Do not implement
> the tasks below; the reshape spec covers them.

- [ ] ~~**3.1** Change `Session<TSignedIn>` so same-user `reauth-required` carries the current signed-in payload.~~ Superseded.
- [ ] ~~**3.2** Change `createSession.reconcile()` to dispose only on `signed-out`, different user, or an explicit app-owned reload boundary.~~ Superseded.
- [ ] ~~**3.3** Update Fuji, Honeycrisp, Opensidian, Tab Manager, Dashboard, and Zhongwen gates so workspace apps treat `reauth-required` as local-usable instead of signed out.~~ Superseded.
- [ ] ~~**3.4** Make reconnect actions call `auth.startSignIn()` or the app-owned repair path without remounting the workspace.~~ Superseded.
- [ ] ~~**3.5** Add tests proving `signed-in -> reauth-required -> signed-in` preserves the same payload instance.~~ Superseded.
- [ ] ~~**3.6** Add tests proving `signed-in user A -> signed-in user B` disposes the old payload and reloads or otherwise refuses the live switch.~~ Superseded.

Guardrail: do not keep a live workspace after real sign-out. This phase only changes same-user network auth failure.

### Phase 4: Repair Machine Auth

Pick one option before editing. Do not leave both half-alive.

#### Option A: Loopback PKCE

- [ ] **4A.1** Replace Better Auth device client usage with an OAuth authorization-code-with-PKCE launcher suitable for CLI or daemon contexts.
- [ ] **4A.2** Load identity through `/workspace-identity`, not `/auth/get-session`.
- [ ] **4A.3** Store `OAuthSession` in the existing machine session store.
- [ ] **4A.4** Revoke refresh tokens through `/auth/oauth2/revoke` on logout.
- [ ] **4A.5** Replace machine-auth tests that fake `/auth/device/*` and `/auth/get-session`.

#### Option B: Restore Device Authorization

- [ ] **4B.1** Reinstall Better Auth `deviceAuthorization()` on the server.
- [ ] **4B.2** Prove the device grant returns tokens that satisfy `workspaces:open` and `/workspace-identity`.
- [ ] **4B.3** Keep `/device` page deletion only if Better Auth owns the verification UI elsewhere.
- [ ] **4B.4** Add an integration-style test against the same plugin set production uses.

Recommended choice: Option A, unless there is a near-term shipped CLI login requirement that makes restoring the device plugin cheaper. The current branch already removed the device server path because it did not satisfy the resource scope model.

### Phase 5: Tighten WebSocket Auth

- [ ] **5.1** Do not gate bearer WebSocket sync with a static `Origin` allowlist. Third-party OAuth clients must be able to sync after consent with a valid scoped bearer.
- [ ] **5.2** Make upgrade detection case-insensitive where middleware branches on `Upgrade`.
- [ ] **5.3** Update `singleCredential` to reject multiple WS bearer entries.
- [ ] **5.4** Strip consumed `bearer.*` entries from `Sec-WebSocket-Protocol`, preserving `epicenter`.
- [ ] **5.5** Add tests for cookie plus WS bearer, HTTP bearer plus WS bearer, duplicate WS bearers, stripped protocol forwarding, and case-insensitive upgrade.
- [ ] **5.6** Decide access-token expiry policy for long-lived WebSockets. Default to client-side reconnect before expiry unless a malicious-client threat model requires server-side close.

### Phase 6: Callback and Extension Durability

- [ ] **6.1** Update callback pages so `startSignIn()` success is not treated as signed-in unless `auth.state.status === 'signed-in'`.
- [ ] **6.2** Add one shared callback helper only after one app proves the fixed flow.
- [ ] **6.3** For WXT, decide whether `launchWebAuthFlow()` belongs in the background entrypoint or whether sidepanel launch can be made resumable through storage.
- [ ] **6.4** Add tests for legacy extension session cleanup and overlapping sign-in attempts if the implementation currently permits overlap.

## Out of Scope

- Billing and credit accounting fixes. Real, but separate.
- API middleware diet and public-route database avoidance. Useful, but separate.
- Full shared sign-in UI replacement. Add it only if three app fixes prove the duplicated state machine is still too expensive.
- Per-message Yjs authorization. Start with connection auth and reconnect policy.
- Rewriting Better Auth or removing it. The issue is how Epicenter composes it, not that Better Auth exists.

## Edge Cases

### Refresh Fails While Offline

1. App has a cached `OAuthSession`.
2. Refresh fails because the network is unavailable.
3. Auth enters `reauth-required`.
4. Existing workspace payload remains mounted.
5. IndexedDB-backed local data remains visible.
6. Sync shows a repair state until reconnect succeeds.

### Same User Reauth Succeeds

1. App is in `reauth-required`.
2. User repairs auth.
3. OAuth returns tokens for the same user.
4. Existing workspace payload stays mounted.
5. Sync reconnects through `auth.openWebSocket()`.

### Different User Signs In

1. Workspace payload is mounted for user A.
2. OAuth returns identity for user B.
3. Session refuses the live switch, disposes user A payload, and reloads.
4. User A decrypted data is not kept in heap for user B.

### Under-Scoped Token Hits a Protected Route

1. Token has valid issuer and audience.
2. Token lacks `workspaces:open`.
3. HTTP route returns 403.
4. WebSocket route fails before Durable Object traffic starts.

### WebSocket Sends Duplicate Credentials

1. Request includes cookie plus bearer, HTTP bearer plus WS bearer, or multiple WS bearers.
2. `singleCredential` rejects the request.
3. Durable Object code never sees raw bearer material.

## Verification Plan

Run focused tests after each phase:

```bash
bun test apps/api/src/auth
bun test packages/auth
bun test packages/svelte-utils
bun --cwd apps/fuji run typecheck
bun --cwd apps/honeycrisp run typecheck
bun --cwd apps/tab-manager run typecheck
```

Manual smoke checks:

```txt
Fuji:
  sign in
  create an entry
  edit rich text body
  confirm child sync uses /documents/*
  force refresh failure
  confirm local entry remains visible

Honeycrisp:
  sign in
  create a note
  edit rich text body
  confirm child sync uses /documents/*
  force refresh failure
  confirm local note remains visible

Tab Manager:
  start sign-in from sidepanel
  close and reopen sidepanel during auth if possible
  confirm there is no stuck PKCE transaction
```

## Grill Pass

These are the questions that must stay answered as implementation proceeds.

1. **Is this one spec or several?** One spec for OAuth resource security plus local workspace lifetime. Billing and middleware diet are explicitly out of scope.
2. **What is the first revert-safe fix?** Scope enforcement on protected routes. It is small, testable, and does not require app UI changes.
3. **What is the highest-risk design choice?** Machine auth. The branch must pick loopback PKCE or restore device authorization before editing.
4. **What is the easiest bug to miss?** Treating `reauth-required` as signed out in an app layout after `createSession` is fixed.
5. **What upstream claim is weakest?** WebSocket header rewrite constraints. Prove locally with tests instead of citing DeepWiki as authority.
6. **What should be refused?** Billing cleanup in this spec. It is real work, but it does not serve the one-sentence thesis.

## Open Questions

1. Should all current protected routes use `workspaces:open`, or should AI, billing, and assets get narrower scopes before launch?
2. Is CLI/device login currently shipped to users? If yes, restore a working machine login path immediately. If no, delete or hide the stale surface until loopback PKCE lands.
3. Should WebSocket token expiry be enforced by client reconnect only, server close only, or both?
4. Which app did the `apps/epicenter` request intend: current `apps/api`, the planned composable `apps/server` host (with its `cloud-apps/` subtree), or a new app? Note: `apps/cloud` is not a separate deployable in the target architecture.
