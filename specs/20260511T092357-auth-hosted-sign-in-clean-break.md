# Hosted Epicenter Sign-In Clean Break

**Date**: 2026-05-11
**Status**: Authoritative implementation spec
**Author**: AI-assisted
**Supersedes**: `specs/20260511T090000-auth-credential-families-minimal-production.md` for the public app sign-in surface. That older spec still contains useful implementation notes for `/auth/oauth-session`, OAuth client registration, extension callbacks, and manual verification, but it preserves the stale `signInWithSocial({ provider })` app API.

## Active Direction

This spec is the source of truth for the next auth cleanup.

Use this shape:

```ts
await auth.beginSignIn({ returnTo });
```

Do not continue this older shape:

```ts
await auth.signIn({ email, password });
await auth.signUp({ email, password, name });
await auth.signInWithSocial({ provider: 'google' });
```

The clean break is narrower and stronger than "put every client on bearer." Apps all start sign-in the same way, but the factory still owns the transport that fits the runtime.

```txt
Public shape:
  every app calls beginSignIn()

Credential boundary:
  hosted Epicenter /sign-in owns all human credential and account-factor UI

Private completion:
  cookie factory completes through HttpOnly session cookies
  bearer factory completes through OAuth code + PKCE + /auth/oauth-session
```

## One-Sentence Thesis

Every Epicenter app starts sign-in by sending the user to the hosted Epicenter sign-in page; the hosted page owns credentials and account factors, while each app receives either a cookie session or a complete bearer session before workspace data unlocks.

## Blunt Recommendation

Make a thorough change, but make it the right thorough change.

Centralize all human credential entry. Apps should not render email/password fields, sign-up fields, recovery UI, social-provider buttons, or future MFA prompts. An app should render one product action: "Sign in to Epicenter." The hosted API page decides whether the user signs in with email/password, creates an account, uses Google, recovers access, or completes a future factor.

Do not collapse cookie and bearer transport into one transport. That would be over-cleaning. Cookie apps and bearer apps solve different credential ownership problems:

```txt
Cookie app:
  Browser cookie jar owns the credential.
  Server sets and clears the credential with Set-Cookie.
  Only for Epicenter-owned apps inside the same approved cookie boundary.

Bearer app:
  App-owned storage owns the credential.
  Server returns set-auth-token and the client sends Authorization.
  For first-party apps outside the cookie boundary, third-party apps,
  extensions, CLIs, daemons, Tauri, and cross-origin SPAs.
```

The clean break is not "everything is OAuth bearer." The clean break is "only hosted Epicenter collects credentials."

The family rule has two axes: ownership and origin shape.

```txt
First-party + same Epicenter cookie boundary:
  createCookieAuth
  direct hosted /sign-in
  no OAuth ceremony for normal sign-in

First-party + outside the cookie boundary:
  createBearerAuth
  OAuth authorization code + PKCE
  consent can still be skipped because ownership is first-party

Third-party:
  OAuth bearer
  consent required
```

Cookie auth is therefore not a generic "browser app" mode. It is an Epicenter web-property mode. A third-party app should not depend on Epicenter's first-party cookie jar, even if a trusted origin entry could make it work technically.

Do not collapse the transport split further in this cleanup:

```txt
Do not make cookie apps bearer just for uniformity.
  Same-site browser apps should not store bearer tokens when HttpOnly cookies
  already give the browser the honest credential owner.

Do not make bearer apps cookie just for simplicity.
  Extensions, CLIs, daemons, Tauri, and cross-origin apps need portable
  app-owned credentials.
```

The stronger collapse is at the app boundary:

```txt
Before:
  apps choose email/password, sign-up, Google, or recovery UI

After:
  apps request sign-in
  hosted Epicenter chooses the credential path
  auth factories complete the session
```

## How Much Simplifies

This simplifies a lot, but not by deleting every auth distinction. It deletes the wrong distinction: app-embedded credential entry.

The current smell is in `packages/auth/src/create-bearer-auth.ts`:

```ts
let pendingBearerToken: string | null = null;
```

That variable exists because bearer email/password sign-in can receive a Better Auth bearer token before Epicenter has a complete `BearerSession`:

```ts
type BearerSession = {
	token: string;
	user: AuthUser;
	encryptionKeys: EncryptionKeys;
};
```

The token is enough to call `/auth/get-session`, but it is not enough for Epicenter to become signed in honestly. The workspace cannot unlock until `encryptionKeys` are present. So the auth client temporarily holds a credential that cannot be exposed as `auth.bearerToken`, cannot become `AuthIdentity`, and cannot be persisted as the real local session yet.

Centralized hosted sign-in deletes that awkward middle state for user-facing sign-in:

```txt
Before:
  app form
    -> auth.signIn({ email, password })
    -> Better Auth returns bearer token
    -> pendingBearerToken
    -> /auth/get-session
    -> derive user + encryptionKeys
    -> persist BearerSession

After:
  app beginSignIn()
    -> hosted sign-in page
    -> OAuth code + PKCE for bearer apps
    -> /auth/oauth-session
    -> returns set-auth-token + user + encryptionKeys
    -> persist complete BearerSession
```

The simplification is asymmetric:

```txt
Refuse:
  Embedded credential forms in every app.

Code family deleted:
  AuthClient.signIn
  AuthClient.signUp
  AuthForm email/password/sign-up state
  bearer email/password hydration path
  pendingBearerToken
  app-level recovery/account-factor drift
  provider-specific public app buttons

User loss:
  Some flows redirect to a hosted auth page instead of staying in an app popover.

Decision:
  Refuse embedded credentials. The product still has email/password, sign-up,
  social login, recovery, and future factors. It has them in one place.
```

## Current State

The auth surface currently asks every `AuthClient` to implement credential methods:

```ts
export type AuthClient = {
	readonly state: AuthState;
	readonly bearerToken: string | null;
	onStateChange(fn: (state: AuthState) => void): () => void;
	signIn(input: {
		email: string;
		password: string;
	}): Promise<Result<undefined, AuthError>>;
	signUp(input: {
		email: string;
		password: string;
		name: string;
	}): Promise<Result<undefined, AuthError>>;
	signInWithSocial(input: {
		provider: SocialProvider;
	}): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	[Symbol.dispose](): void;
};
```

`packages/svelte-utils/src/auth-form/auth-form.svelte` uses that whole surface directly:

```txt
AuthForm
  has mode = sign-in | sign-up
  owns email, password, name
  calls auth.signIn(...)
  calls auth.signUp(...)
  calls onSocialSignIn()
```

That means every app using `AuthForm` is a credential collector. It also means every new account factor becomes either a shared UI expansion or a product inconsistency.

The API already has the centralized pieces:

```txt
apps/api/src/app.ts
  GET /sign-in
  GET /consent
  GET /device
  POST /auth/oauth-session
  GET/POST /auth/* -> Better Auth handler

apps/api/src/auth/create-auth.ts
  oauthProvider({
    loginPage: '/sign-in',
    consentPage: '/consent',
    requirePKCE: true,
    validAudiences: [baseURL],
    allowDynamicClientRegistration: false,
  })

apps/api/src/auth-pages/scripts/sign-in.ts
  POST /auth/sign-in/email
  POST /auth/sign-up/email
  POST /auth/sign-in/social
  preserves oauth_query when present
```

The local hosted page is not a theory. It exists. The missing move is making it the credential boundary for apps.

## Desired State

The shared auth client stops exposing credential-specific verbs. Apps do not know whether the hosted page chooses email/password, sign-up, Google, recovery, or a future factor.

```ts
export type AuthClient = {
	readonly state: AuthState;
	readonly bearerToken: string | null;
	onStateChange(fn: (state: AuthState) => void): () => void;
	beginSignIn(input?: {
		returnTo?: string;
	}): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	[Symbol.dispose](): void;
};
```

The ideal signed-out app UI becomes tiny:

```txt
Signed-out state
  "Sign in to Epicenter"
    -> auth.beginSignIn()
```

No app imports a credential form. No app decides providers. No app handles sign-up mode. No app adds account recovery.

## Relationship To Credential Families Spec

`specs/20260511T090000-auth-credential-families-minimal-production.md` was correct about the transport facts:

```txt
Cookie apps:
  browser cookie jar owns the session credential

Bearer apps:
  app storage owns a durable Better Auth session token

/auth/oauth-session:
  exchanges oauthProvider access tokens for Epicenter's complete bearer session
```

It is no longer correct about the public app sign-in method. The app should not call `signInWithSocial({ provider })`, because provider choice belongs to hosted `/sign-in`.

Carry these pieces forward from the older spec:

```txt
OAuth public-client seeding
registered redirect URIs for bearer clients
Chrome extension launchWebAuthFlow constraints
Tauri callback decision notes
CLI device flow remains separate and already bearer-shaped
manual verification matrix
```

Replace this older model:

```txt
Every app belongs to a credential family.
Each family signs in differently.
```

With this model:

```txt
Every app starts hosted sign-in the same way.
Each factory completes the session differently.
```

## Research Findings

### Better Auth

Better Auth's `oauthProvider` plugin supports a custom `loginPage`. Its docs say that if a user is not logged in during the provider flow, the user is redirected to that page, and after a new session is created the plugin continues the authorization flow. Source: [Better Auth OAuth 2.1 Provider](https://better-auth.com/docs/plugins/oauth-provider).

Better Auth's bearer plugin returns a session token through the `set-auth-token` response header after sign-in. The docs show that bearer clients store that token and send it through `Authorization: Bearer`. Source: [Better Auth Bearer Token Authentication](https://better-auth.com/docs/plugins/bearer).

Better Auth custom session fields are attached to `getSession` and `useSession` through `customSession`. Source: [Better Auth Session Management](https://better-auth.com/docs/concepts/session-management).

Implication:

```txt
Email/password directly from a bearer app naturally gives token first.
Epicenter needs token + user + encryptionKeys.
Hosted OAuth + /auth/oauth-session lets Epicenter return that full shape once.
```

### Hono and Worker Routing

Hono executes handlers and middleware in registration order. A fallback or catch-all route must be registered after specific routes. Source: [Hono routing priority](https://hono.dev/docs/api/routing).

The current API order is correct:

```txt
/sign-in
/consent
/device
/auth/oauth-session
/auth/*
```

`/auth/oauth-session` must stay before `/auth/*`, because the generic Better Auth handler should not swallow Epicenter's session exchange route.

### Cloudflare Cookies

Cross-site cookies require `SameSite=None; Secure`. Cloudflare documentation also describes CHIPS partitioning, where partitioned cookies are keyed by the top-level site. Source: [Cloudflare SameSite cookie interaction](https://developers.cloudflare.com/waf/troubleshooting/samesite-cookie-interaction/).

Local code already documents the practical consequence in `apps/api/src/auth/create-auth.ts`: a cross-origin fetch from an app to the API is a poor place to rely on a state cookie being stored. Hosted top-level navigation is a better credential boundary than app-embedded cross-origin credential fetch.

### Chrome Extensions and WXT

WXT provides types and build structure, but the OAuth callback constraints come from the browser extension platform. Chrome's identity API generates callback URLs matching `https://<app-id>.chromiumapp.org/*`, and `launchWebAuthFlow` closes the window when the provider redirects to that pattern. Source: [Chrome identity API](https://developer.chrome.com/docs/extensions/reference/api/identity).

Implication:

```txt
Tab Manager should remain bearer.
Its platform auth module should own launchWebAuthFlow.
Auth core should not know Chrome callback mechanics.
```

### SvelteKit SPA Callback Routes

SvelteKit static or SPA deployments need fallback routing for non-prerendered routes, and `paths.base` must be included in root-relative links and callback URLs when the app is served from a subpath. Sources: [SvelteKit adapter-static fallback](https://svelte.dev/docs/kit/adapter-static) and [SvelteKit paths.base](https://svelte.dev/docs/kit/configuration#paths).

Implication:

```txt
Opensidian callback URLs must include base path when deployed under a base.
The hosted sign-in launcher should not hard-code root paths.
```

### Tauri

Tauri supports deep links through `@tauri-apps/plugin-deep-link`. Desktop deep links have platform constraints: macOS requires static config and installed app testing, while Linux and Windows can register at runtime in some cases. Source: [Tauri deep linking](https://v2.tauri.app/plugin/deep-linking/).

Implication:

```txt
Whispering or future Tauri apps should be bearer.
The Tauri launcher is a platform adapter, not auth-core behavior.
Loopback can still be considered, but it is a separate product decision.
```

## Architecture

### Current Mixed Boundary

```txt
App UI
  |
  | email/password/social provider choice
  v
AuthClient
  |
  +-- cookie auth
  |     -> Better Auth cookie session
  |
  +-- bearer auth
        -> Better Auth bearer token
        -> pendingBearerToken
        -> /auth/get-session
        -> BearerSession
```

Problem: the app and auth core both participate in credential entry. Bearer auth also has a token-only intermediate state that does not match Epicenter's signed-in contract.

### Proposed Boundary

```txt
App UI
  |
  | beginSignIn()
  v
Hosted Epicenter Sign-In
  |
  +-- email/password
  +-- sign-up
  +-- Google
  +-- recovery
  +-- future MFA/passkey
  |
  v
Session family
  |
  +-- cookie app
  |     -> Set-Cookie
  |     -> getSession/useSession
  |     -> AuthIdentity { user, encryptionKeys }
  |
  +-- bearer app
        -> OAuth code + PKCE
        -> OAuth access token
        -> /auth/oauth-session
        -> BearerSession { token, user, encryptionKeys }
```

The hosted page owns credential semantics. The auth factory owns transport semantics.

## Proposed Public API

### Shared Auth Client

```ts
export type AuthClient = {
	readonly state: AuthState;
	readonly bearerToken: string | null;
	onStateChange(fn: (state: AuthState) => void): () => void;
	beginSignIn(input?: {
		returnTo?: string;
	}): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	[Symbol.dispose](): void;
};
```

### Cookie Auth

```ts
export type CreateCookieAuthConfig = {
	baseURL?: string;
	getSignInURL?: (input: { returnTo?: string }) => string;
	initialIdentity?: AuthIdentity | null;
	saveIdentity?: (value: AuthIdentity | null) => void | Promise<void>;
};
```

Suggested behavior:

```txt
beginSignIn({ returnTo })
  -> window.location.href = getSignInURL({ returnTo })
  -> hosted /sign-in sets cookie
  -> app reloads or returns
  -> Better Auth useSession updates identity
```

`@epicenter/auth` should not import browser globals by default. The Svelte/browser wrapper or platform auth file can inject the navigation launcher.

### Bearer Auth

```ts
export type CreateBearerAuthConfig = {
	baseURL?: string;
	sessionStorage: BearerSessionStorage;
	signInLauncher: HostedSignInLauncher;
};

export type HostedSignInLauncher = {
	begin(input: {
		returnTo?: string;
	}): Promise<Result<{ accessToken: string } | null, unknown>>;
};
```

Suggested behavior:

```txt
beginSignIn()
  -> signInLauncher.begin()
  -> if null, flow redirected away and will resume later
  -> if accessToken, POST /auth/oauth-session
  -> read set-auth-token
  -> normalize body into BearerSession
  -> update in-memory auth state
  -> persist BearerSession
```

Rename `oauthAdapter` to `signInLauncher` or `hostedSignIn` if this clean break lands. `oauthAdapter.signInWithSocial({ provider })` is now a stale name because the app no longer chooses a social provider.

### Hosted Sign-In Launcher Package

`packages/oauth-client` can keep the PKCE implementation, but its public naming should stop saying "social":

```txt
createBrowserHostedSignInLauncher
createExtensionHostedSignInLauncher
createTauriHostedSignInLauncher
createOAuthClient
```

This package should still not depend on `@epicenter/auth` or `BearerSession`. It returns OAuth access tokens only. Auth core owns the exchange into durable session state.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Credential entry owner | 2 coherence | Hosted Epicenter sign-in only | The thesis says credentials belong to the auth server boundary. Embedded app forms are the source of the bearer partial-session smell. |
| Remove `AuthClient.signIn` | 2 coherence | Remove | Email/password is a hosted-page implementation detail, not an app auth method. |
| Remove `AuthClient.signUp` | 2 coherence | Remove | Sign-up is an account lifecycle flow. Apps should not own it. |
| Replace `signInWithSocial({ provider })` | 2 coherence | Use `beginSignIn()` | Provider choice belongs to the hosted page. Keeping provider in the app preserves a stale mental model. |
| Cookie family eligibility | 2 coherence | Epicenter-owned and same cookie boundary only | Cookie auth relies on Epicenter's first-party browser cookie jar. That is an ownership and origin-boundary privilege, not a generic browser-app mode. |
| Cookie app sign-in path | 2 coherence | Direct hosted `/sign-in` | Cookie apps want a Better Auth cookie, not an OAuth grant. OAuth authorize is ceremony unless the app needs bearer semantics. |
| First-party outside cookie boundary | 2 coherence | Bearer with skip-consent eligibility | Ownership can be first-party while origin shape still forces bearer, e.g. Opensidian or a desktop app. Consent follows ownership, not transport. |
| Third-party app transport | 2 coherence | OAuth bearer with consent | Third-party apps should not depend on Epicenter's first-party cookie jar. OAuth exists for delegated access. |
| Keep `createCookieAuth` | 1 evidence and 2 coherence | Keep | Better Auth is cookie-native, local code already supports cookie apps, and unifying on bearer adds callback registration and token storage for no clear product win. |
| Keep `createBearerAuth` | 1 evidence | Keep | Extensions, CLIs, Tauri, daemons, third-party apps, and cross-origin SPAs cannot rely on the same cookie assumptions. Better Auth documents bearer as the alternative for APIs that need bearer tokens. |
| Keep `/auth/oauth-session` | 2 coherence | Keep | It is the server-owned bridge from OAuth proof to Epicenter's complete bearer session shape. |
| Keep `encryptionKeys` in `AuthIdentity` | 3 taste under current constraints | Keep for now | Local-first apps need cached complete identity to unlock on boot. A separate unlock step is not justified until there is a real lock product or user-held keys. |
| Do not add `transport: 'cookie' | 'bearer'` | 2 coherence | Refuse | The two factories already put the family decision at construction. A flag makes runtime branching leak into callers. |
| Do not add provider buttons in apps | 2 coherence | Refuse | The hosted page owns provider availability and ordering. |

## What Gets Deleted or Simplified

### Auth Core

Delete:

```txt
AuthClient.signIn
AuthClient.signUp
AuthClient.signInWithSocial
SocialProvider from the shared app-facing surface
pendingBearerToken
hydrateSignedOutSession
readTokenFromAuthCommandData
bearer email/password command handling
cookie email/password command handling
```

Keep:

```txt
AuthState
AuthIdentity
BearerSession
createCookieAuth
createBearerAuth
auth.fetch
auth.bearerToken
auth.signOut
customSession parsing
/auth/oauth-session exchange
```

### Shared Svelte UI

Replace `AuthForm` with a much smaller signed-out action component:

```txt
AuthForm today:
  Create account mode
  Sign in mode
  email state
  password state
  name state
  Google button
  validation errors from three paths

HostedSignInPrompt:
  one button
  pending state
  error state if launch fails
```

The shared `AccountPopover` no longer needs `onSocialSignIn`; it can receive `auth` and call `auth.beginSignIn()`.

### Apps

App family selection follows this rule:

```txt
createCookieAuth:
  Epicenter-owned app
  same approved Epicenter cookie boundary
  normal sign-in goes directly to hosted /sign-in

createBearerAuth:
  first-party app outside the cookie boundary
  third-party app
  extension
  desktop app
  CLI or daemon
```

Cookie apps keep their cookie platform file:

```txt
apps/dashboard/src/lib/platform/auth/cookie.ts
apps/fuji/src/lib/platform/auth/cookie.ts
apps/honeycrisp/src/lib/platform/auth/cookie.ts
apps/zhongwen/src/lib/platform/auth/cookie.ts
```

Bearer apps keep their bearer platform file:

```txt
apps/opensidian/src/lib/platform/auth/bearer.ts
apps/tab-manager/src/lib/platform/auth/bearer.ts
future apps/whispering auth
```

App routes no longer import `AuthForm` or call `auth.signInWithSocial({ provider: 'google' })`.

## Real Downsides

### Redirects and Lost Popover Context

The user leaves the app surface for sign-in. That is acceptable. Authentication is a high-trust boundary, and the hosted page can provide a consistent account experience.

Mitigation:

```txt
beginSignIn({ returnTo: current URL })
hosted page returns to app
first-party clients can skip consent
```

### Local Dev Callback Registration

This is the biggest practical cost. Bearer apps need registered callback URLs. The repo currently declares public clients in `packages/constants/src/oauth.ts`, but the API does not obviously seed them while `allowDynamicClientRegistration` is disabled.

This must be fixed before deleting old sign-in paths.

### Extension Callback Handling

Chrome extension OAuth must use the extension identity callback URL shape. The app id is part of the redirect URI, so production and development extension ids need deliberate registration.

This is acceptable because Tab Manager is already in the bearer family. The platform file owns that callback.

### Tauri Callback Handling

Tauri needs a callback strategy. Deep links work but have platform constraints. Loopback is also viable, but that would require a separate launcher implementation.

This is deferred until Whispering or another Tauri app actually adds auth.

### Offline Sign-In

No hosted sign-in works offline. Cached sessions can still unlock local-first data if the app already has a complete `BearerSession` or cached cookie identity. New sign-in cannot happen offline.

That is acceptable. Offline account creation or recovery is not a real product promise.

### Password Manager UX

This likely improves. One hosted Epicenter origin owns username and password fields, so password managers learn one site instead of several app origins. The downside is that app-specific context is less visible during credential entry.

### Cookie Boundary

Cookie apps still depend on browser cookie behavior. That is acceptable only for Epicenter-owned apps inside the approved Epicenter cookie boundary. It is not acceptable for cross-origin apps like Opensidian, which should stay bearer even if the product is first-party.

The distinction matters:

```txt
Ownership:
  who controls and publishes the app

Cookie boundary:
  whether the browser can honestly use Epicenter's first-party cookie jar
```

Both must be true for `createCookieAuth`.

### Account Recovery and MFA

Centralizing makes these easier, but it also makes the hosted page more load-bearing. The hosted page must become production UI, not a minimal helper page.

## Encryption Keys and Workspace Unlock

Do not split `encryptionKeys` out of `AuthIdentity` as part of this break.

The current encryption system is server-managed workspace value encryption. The auth server derives per-user keys from `ENCRYPTION_SECRETS` and attaches them to the session response. The workspace builder reads keys synchronously through:

```ts
encryptionKeys: () => requireSignedIn(auth).encryptionKeys
```

For local-first apps, that matters:

```txt
Opensidian boot:
  load cached BearerSession
  auth.state is signed-in immediately
  open workspace
  attach IndexedDB
  attach encrypted stores with cached keys

Tab Manager boot:
  await chrome.storage auth session
  create bearer auth
  open encrypted workspace
```

A separate key-loading step would add:

```txt
auth signed-in but locked
workspace locked
key fetch pending
key fetch failed
offline signed-in but locked
same-user key refresh
lock/unlock UI
```

That may become valuable later if Epicenter wants a Bitwarden-style lock model, user-held keys, PIN unlock, passphrase unlock, or explicit memory wipe. It is not required to fix the current auth smell.

The real caveat is different: current docs note no explicit encrypted-store deactivation hook after logout. Workspace disposal is the current key-drop boundary. If the threat model changes, handle that as an encryption lifecycle spec, not as a reason to keep credential forms in apps.

## Migration Plan

Use Build, Prove, Remove ordering. Do not delete old paths until the hosted path is working in every app family.

### Wave 1: Hosted Sign-In Production Base

- [ ] **1.1** Add or verify OAuth public client seeding for `EPICENTER_OAUTH_PUBLIC_CLIENTS` while dynamic registration stays disabled.
- [ ] **1.2** Add an explicit first-party marker for seeded Epicenter-owned OAuth clients and use it to skip consent.
- [ ] **1.3** Add tests that `/sign-in` preserves OAuth continuation for email/password, sign-up, and Google.
- [ ] **1.4** Add tests that `/auth/oauth-session` returns `set-auth-token`, `user`, and `encryptionKeys` for a valid OAuth access token.
- [ ] **1.5** Add a smoke path for already-signed-in `/sign-in?sig=...` continuing to `/auth/oauth2/authorize`.

### Wave 2: Add New Auth Surface Beside Old Methods

- [ ] **2.1** Add `beginSignIn()` to `AuthClient` while keeping `signIn`, `signUp`, and `signInWithSocial` temporarily.
- [ ] **2.2** Implement cookie `beginSignIn()` through an injected hosted sign-in navigator.
- [ ] **2.3** Implement bearer `beginSignIn()` through the existing PKCE launcher and `/auth/oauth-session`.
- [ ] **2.4** Rename the bearer launcher interface away from social-provider wording, or add the new name beside the old one temporarily.
- [ ] **2.5** Add tests proving bearer `beginSignIn()` persists a complete `BearerSession` without `pendingBearerToken`.

### Wave 3: Migrate Shared UI

- [ ] **3.1** Replace `AuthForm` usage with a hosted sign-in prompt.
- [ ] **3.2** Remove `onSocialSignIn` from `AccountPopover`.
- [ ] **3.3** Update signed-out copy to say "Sign in to Epicenter" consistently.
- [ ] **3.4** Keep old `AuthForm` on disk but stop importing it.

### Wave 4: Migrate Apps

- [ ] **4.1** Migrate cookie apps to call `auth.beginSignIn()`.
- [ ] **4.2** Migrate Opensidian callback handling to provider-agnostic hosted sign-in completion.
- [ ] **4.3** Migrate Tab Manager to provider-agnostic hosted sign-in completion.
- [ ] **4.4** Confirm no app imports `AuthForm`.
- [ ] **4.5** Confirm no app calls `auth.signIn`, `auth.signUp`, or `auth.signInWithSocial`.

### Wave 5: Verify Before Deletion

- [ ] **5.1** Run auth package typecheck and tests.
- [ ] **5.2** Run oauth-client package typecheck and tests.
- [ ] **5.3** Run API auth tests.
- [ ] **5.4** Smoke cookie sign-in in dashboard or a representative cookie app.
- [ ] **5.5** Smoke bearer sign-in in Opensidian.
- [ ] **5.6** Smoke bearer sign-in in Tab Manager with `launchWebAuthFlow`.

### Wave 6: Delete Old Credential Entry

- [ ] **6.1** Remove `AuthClient.signIn`.
- [ ] **6.2** Remove `AuthClient.signUp`.
- [ ] **6.3** Remove `AuthClient.signInWithSocial`.
- [ ] **6.4** Delete `AuthForm` or replace its export with the new hosted prompt.
- [ ] **6.5** Delete `pendingBearerToken` and bearer email/password hydration helpers.
- [ ] **6.6** Delete old tests for app-embedded credential methods.
- [ ] **6.7** Update `auth` skill docs to describe hosted sign-in and two transport families.

## Straggler Searches

Before deletion is done, these should be empty outside historical specs:

```txt
rg "auth\.signIn\("
rg "auth\.signUp\("
rg "signInWithSocial"
rg "onSocialSignIn"
rg "AuthForm"
rg "pendingBearerToken"
rg "readTokenFromAuthCommandData"
rg "Continue with Google" apps packages
```

Allowed matches:

```txt
apps/api/src/auth-pages
historical specs
tests that intentionally cover hosted sign-in
```

## Edge Cases

### User Cancels Hosted Sign-In

Bearer launcher returns `Ok(null)` when the flow redirected away or was cancelled without a token. Auth state remains unchanged. UI clears pending state.

### OAuth Access Token Valid But Session Missing

`/auth/oauth-session` returns `401 invalid_oauth_token`. The app remains signed out. This can happen if the Better Auth session is revoked between authorization and exchange.

### Cookie App Already Signed In

`/sign-in` sees a valid session. If signed OAuth params are present, it redirects to `/auth/oauth2/authorize`. If `callbackURL` is present and local, it redirects there. Otherwise it can render a signed-in confirmation.

### Bearer App Has Cached Session And Is Offline

The app can boot from the cached `BearerSession`. It can open local encrypted data because `user` and `encryptionKeys` are present. Network sync fails normally.

### Better Auth Session Rotates Token

Bearer auth keeps the `set-auth-token` `onSuccess` rotation path for normal authenticated requests. This is independent of hosted sign-in.

### Same User Gets New Encryption Keys

Current workspace behavior does not remount on same-user identity update. Existing encrypted stores keep the keyring they derived at attachment time. This spec does not change that. A future key-rotation spec should own reattachment or explicit activation policy.

## Decisions Log

- Keep cookie and bearer factories.
  Revisit when: all production apps can use the same credential owner without losing HttpOnly cookie benefits or adding public OAuth client burden.

- Keep `encryptionKeys` in auth identity.
  Revisit when: Epicenter introduces explicit lock/unlock, user-held keys, PIN unlock, or a memory-wipe threat model stronger than current workspace disposal.

- Keep OAuth access token exchange in auth core, not oauth-client.
  Revisit when: another package besides auth must exchange access tokens for durable sessions, which would be a smell by itself.

- Keep hosted sign-in as Hono JSX for now.
  Revisit when: account recovery, MFA, and passkeys make the page large enough to justify a separate built frontend.

## Open Questions

1. What exact database/config field marks a client as first-party?
   - Recommendation: use an explicit server-owned registration field or seeded client list, not a naming convention. Consent policy is too important to infer from a client id prefix.

2. What exact user-facing phrase should apps use?
   - Recommendation: "Sign in to Epicenter." It names the account boundary directly.

3. Should hosted sign-in support passkeys in this same break?
   - Recommendation: no. This break should move credential entry to one place. Passkeys can be the first major feature that proves the new boundary.

4. Should Tauri use loopback or deep link?
   - Recommendation: defer until Whispering needs auth. Deep links are supported by Tauri but carry platform setup and testing constraints. Loopback may be simpler for desktop OAuth, but it needs its own launcher design.

5. Should `AuthClient.bearerToken` stay on the shared surface?
   - Recommendation: yes for now. Workspace sync code reads it uniformly, and cookie auth returning `null` is already the transport contract. Revisit only if sync moves behind `auth.fetch` or a transport abstraction.

## Final Shape Test

A new app should answer exactly two auth questions:

```txt
1. Is this a cookie app or a bearer app?
2. What launcher or navigation function starts hosted Epicenter sign-in?
```

If the app has to answer "which providers do we show," "how does sign-up work," "where do password reset links go," or "how do we collect the second factor," the clean break failed.
