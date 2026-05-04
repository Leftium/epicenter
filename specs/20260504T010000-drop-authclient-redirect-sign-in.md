# Drop AuthClient Redirect Sign-In: Apps Mint Credentials Locally

**Date**: 2026-05-04
**Status**: Draft
**Author**: AI-assisted (Claude)
**Branch**: TBD (per-app branches; ships independently)
**Depends on**: `specs/20260503T230000-auth-unified-client-two-factories.md` (Waves 1-6, implemented)

## One-Sentence Test

`AuthClient` exposes one method per sign-in flow shape (not one per provider); the OIDC-token flow is `signInWithIdToken`; `signInWithSocialRedirect` disappears.

If any app still calls `signInWithSocialRedirect`, or `AuthClient` still exposes it, the migration is not done.

## Overview

The unified-client spec (Waves 1-6) made `signInWithIdToken` first-class but kept `signInWithSocialRedirect` on the `AuthClient` surface for backwards-compatibility while each browser app migrated its sign-in UI to a local credential-minting mechanism. This spec finishes that migration: each app gains a `getGoogleIdToken()` helper that mints an ID token using the mechanism native to its runtime, then the redirect method is deleted from `AuthClient`.

The work ships per-app and finishes with one "delete the redirect" commit in `@epicenter/auth`.

The principle: **`AuthClient` accepts a credential per FLOW SHAPE, not per provider.** Today every redirect-using app is a browser SPA, so each per-app helper uses Google Identity Services (GIS) popup. The same `signInWithIdToken` method serves Google and any future OIDC provider (Apple, Microsoft) without surface growth: a new provider is a config addition, not a new method. Tab-manager already proves this from another environment (`chrome.identity.launchWebAuthFlow` mints the token; same call site).

## Why this is its own spec

The unified-client spec's thesis is *"`AuthClient` is the credential's lifecycle handle on this runtime; `createCookieAuth` and `createBearerAuth` produce the same interface, differing only in how they acquire, persist, and present the credential."* That thesis stays true today: `signInWithIdToken` is on the surface; `signInWithSocialRedirect` riding alongside doesn't contradict the unified shape.

This spec's thesis is different: per-app login UX migration to a locally-minted credential. Different verbs, different scope (per-app vs auth-package), different layer. Per the cohesive-clean-breaks skill: when work ships independently and has its own sentence, it deserves its own spec.

The repo's prevailing pattern matches: see the merge/collapse split in `20260421T170000-merge-document-into-workspace.md` and `20260421T170000-collapse-document-and-workspace-primitives.md`.

## Motivation

### Current state

```ts
type AuthClient = {
  // ...
  signInWithIdToken(input: {
    provider: string; idToken: string; nonce: string;
  }): Promise<Result<undefined, AuthError>>;
  signInWithSocialRedirect(input: {
    provider: string; callbackURL: string;
  }): Promise<Result<undefined, AuthError>>;
  // ...
};
```

Both methods proxy to Better Auth's `signIn.social()` with different args. The redirect path's `Result<undefined, AuthError>` Ok branch is unreachable because the page navigates away on success. Google supports OIDC ID tokens, which any environment (browser, extension, Tauri) can mint locally. The redirect path is structurally redundant for OIDC providers and structurally broken for cross-origin bearer apps (the cookie set on the API origin can't reach the SPA's session storage).

Browser apps currently call `signInWithSocialRedirect`:

```
apps/dashboard
apps/fuji
apps/honeycrisp
apps/opensidian
apps/zhongwen
```

`apps/tab-manager` already uses `signInWithIdToken` (extension context cannot use redirect).

### Desired state

```ts
type AuthClient = {
  signIn(input): ...                  // email/password (existing)
  signUp(input): ...                  // email/password (existing)
  signInWithIdToken(input: {          // OIDC flow: Google now, Apple/Microsoft compatible
    provider: OIDCProvider;           // 'google' | 'apple' | 'microsoft' | 'facebook' | 'cognito' | 'line' | 'paypal'
    idToken: NonNullable<SocialSignInInput['idToken']>;  // { token, nonce?, accessToken?, user?, ... }
  }): Promise<Result<undefined, AuthError>>;
  signOut(): ...
  // signInWithSocialRedirect: gone
  // Future flow methods (separate specs): signInWithMagicLink, signInWithSocial (handoff), signInWithPasskey
};
```

Each browser app:
1. Imports `getGoogleIdToken` from `@epicenter/svelte/google-sign-in` (sub-export from the existing `@epicenter/svelte` package).
2. Calls `auth.signInWithIdToken(await getGoogleIdToken({ clientId: env.GOOGLE_CLIENT_ID }))` from the sign-in button.
3. Drops the `callbackURL` and the redirect-flow listener.

`tab-manager` (Chrome extension) keeps its in-app `chrome.identity.launchWebAuthFlow` helper; only its call shape updates to the nested `idToken` form.

`SocialSignInFailed` stays. Its only producer is now `signInWithIdToken`, which still describes what happened (a social sign-in failed). No code change to the variant itself.

## Per-app surface map

| App | Environment | Current sign-in | Migration target | Token-mint mechanism |
|---|---|---|---|---|
| dashboard | Browser SPA (cookie) | `signInWithSocialRedirect` | `signInWithIdToken` | GIS popup |
| fuji | Browser SPA (cookie) | `signInWithSocialRedirect` | `signInWithIdToken` | GIS popup |
| honeycrisp | Browser SPA (cookie) | `signInWithSocialRedirect` | `signInWithIdToken` | GIS popup |
| opensidian | Browser SPA (bearer, cross-origin) | `signInWithSocialRedirect` | `signInWithIdToken` | GIS popup |
| zhongwen | Browser SPA (cookie) | `signInWithSocialRedirect` | `signInWithIdToken` | GIS popup |
| tab-manager | Chrome extension MV3 (bearer) | `signInWithIdToken` | unchanged | `chrome.identity.launchWebAuthFlow` with `response_type=id_token` |
| whispering | Tauri | none | unchanged | (deferred; will use OAuth 2.1 PKCE + localhost loopback via existing `oauthProvider()`, see Deferred section) |

Every redirect-using app today is a browser SPA, so every per-app helper in this migration uses GIS. The two exceptions on the list (`tab-manager`, `whispering`) confirm that the `signInWithIdToken` surface is environment-agnostic: each runtime mints its token however it natively can.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Surface shape | One method per sign-in FLOW (not per provider). `signInWithIdToken` covers all OIDC providers; future flows like magic link or non-OIDC redirect get their own method | Mirrors Better Auth's idiom (`authClient.signIn.social`, `signIn.email`, `signIn.magicLink`). Adding a 5th OIDC provider is a config change, not a new method. See "Why per-flow framing" below. |
| Provider scope (launch set) | OIDC: Google (now), Apple (cheap follow-on; same flow). Non-OIDC: GitHub via API-hosted page redirect for cookie SPAs (existing); deferred for bearer apps. Magic link: separate future spec. | Grounded in research across 20 comparable apps (Notion, Linear, Cursor, Vercel, etc.): Google + GitHub + Apple is the consensus dev-tool set. Microsoft as first-party social shows up in only 3/20 apps; reach via SAML at enterprise tier instead. See "Provider scope" below. |
| `provider` type | Constrain to providers Better Auth implements `verifyIdToken` for: `'google' \| 'apple' \| 'microsoft' \| 'facebook' \| 'cognito' \| 'line' \| 'paypal'`. Today only Google is configured server-side; the union narrows to actually-supported providers as the server config grows. | Letting `provider: SocialSignInInput['provider']` widen to the full Better Auth union (including GitHub, Discord, etc.) is a runtime trap: callers can pass a non-OIDC provider and get a `ID_TOKEN_NOT_SUPPORTED` error at runtime. Constrain at the type. |
| `signInWithIdToken` shape | Derive `idToken` parameter type from Better Auth's `signIn.social` parameter type via `Parameters<typeof betterAuthClient.signIn.social>[0]`. Do not re-declare structurally. | Stays in sync with Better Auth automatically. New optional fields (`accessToken`, `refreshToken`, `expiresAt`, `user` for Apple/Facebook) become available without an Epicenter API change. Verified via DeepWiki: Better Auth's client-side type is generated from the same `socialSignInBodySchema` Zod schema as the server route. |
| Helper home (browser SPAs) | Sub-export from existing `@epicenter/svelte` package: `@epicenter/svelte/google-sign-in`. | All 5 redirect-using apps are Svelte browser SPAs that already depend on `@epicenter/svelte` (it hosts `auth-form`, `account-popover`, etc., all browser-only sign-in UI). A new package for one ~30 LOC function would be over-engineered. The grilling pass surfaced this: tab-manager keeps its 25-line helper inline and that's fine; the 5 browser SPAs deserve a shared helper, but a sub-export from the right existing package is enough. NOT placed in `@epicenter/auth-svelte` (that's the Svelte wrapper around `AuthClient`, wrong concern). |
| Helper home (other environments) | Per-app, inline | `tab-manager` keeps its `chrome.identity.launchWebAuthFlow` helper in-app. Future Tauri (whispering) gets a per-app loopback OAuth helper (Future direction item 3). The minting mechanism is environment-specific and the per-app helpers are small. |
| GIS flow (browser SPAs) | Popup primary, one-tap secondary | Popup is reliable; one-tap improves return-user UX but has eligibility quirks (FedCM, third-party cookies). |
| Nonce generation | `crypto.randomUUID()` per sign-in attempt | Prevents replay; required by Better Auth's `idToken` flow. |
| `signInWithSocialRedirect` removal | Delete after every browser app migrates | Hybrid would leave the dishonest method on the surface. |
| Wave order | Pre-work first (helper sub-export + atomic type change + tab-manager update IN ONE COMMIT), then per-app migrations, then delete from auth last | P.2 (type widens) and P.3 (tab-manager updates to nested shape) MUST be the same commit, or the build breaks between them. |

### Why per-flow framing (not per-provider, not all-in-one)

Three competing shapes were considered. The rationale for picking per-flow:

```
Per-provider methods (rejected)          Per-flow methods (chosen)              All-in-one (deferred)
auth.signInWithGoogle({...})             auth.signInWithIdToken({               auth.signInWithSocial({
auth.signInWithGitHub({...})               provider: 'google' | 'apple',         provider: 'google' | 'github' | ...
auth.signInWithApple({...})                idToken: { ... }                     })
auth.signInWithMicrosoft({...})          })
                                         auth.signInWithSocial?(...)            (one method via unified handoff
N methods, grows with providers          Future: magic link, passkey            plugin; see Future direction)
```

- **Per-provider** (`signInWithGoogle`, etc.) doesn't match Better Auth's idiom; `AuthClient` surface grows linearly with providers; conflates "provider identity" with "user flow." Two providers in the same flow (Google + Apple, both OIDC) deserve one method, not two.
- **Per-flow** (chosen) mirrors Better Auth (`signIn.social`, `signIn.email`, `signIn.magicLink`); each method covers N providers in that flow shape; adding a provider is config + a string in the union.
- **All-in-one** (`signInWithSocial({ provider })` covering OIDC + non-OIDC + every environment) requires per-environment OAuth 2.1 client adapters via the existing `oauthProvider()` plugin. Architecturally cleanest long-term but blocked behind a real bearer + non-OIDC requirement; see Future direction item 3.

### Type derivation pattern

The current `signInWithIdToken` declares its input structurally:

```ts
// Current (structural duplication; locks out optional Better Auth fields)
signInWithIdToken(input: { provider: string; idToken: string; nonce: string }): Promise<...>;
```

The spec changes this to derive `idToken` from Better Auth while constraining `provider` to OIDC providers explicitly:

```ts
// Proposed (idToken derived from Better Auth; provider constrained to OIDC literal union)
type SocialSignInInput = Parameters<typeof betterAuthClient.signIn.social>[0];

// Better Auth implements verifyIdToken for these providers; others (GitHub, Discord)
// would fail at runtime with ID_TOKEN_NOT_SUPPORTED.
type OIDCProvider = 'google' | 'apple' | 'microsoft' | 'facebook' | 'cognito' | 'line' | 'paypal';

signInWithIdToken(input: {
  provider: OIDCProvider;
  idToken: NonNullable<SocialSignInInput['idToken']>;
}): Promise<Result<undefined, AuthError>>;
```

Implementation note: `betterAuthClient` is a local in `createAuthCore`, so referencing its type at the module-level `AuthClient` declaration requires either (a) inferring `AuthClient` itself via `ReturnType<typeof createAuthCore>` (preferred per repo's `AGENTS.md` type-derivation convention), or (b) extracting a typed client alias to module scope. Pick whichever keeps Go-to-Definition useful.

The user-facing call shape changes from flat to nested:

```ts
// Before
await auth.signInWithIdToken({ provider: 'google', idToken, nonce });

// After
await auth.signInWithIdToken({ provider: 'google', idToken: { token: idToken, nonce } });
```

`tab-manager` is the only caller today; it gets updated in the pre-work PR to keep the build green.

## Implementation plan

This spec ships in three waves: pre-work (one PR), per-app migrations (one PR each), final deletion (one PR after all per-app PRs land).

### Pre-work wave (ships first; ONE atomic commit)

P.1 through P.4 are a single commit because P.2 widens the `signInWithIdToken` type, which breaks tab-manager (P.3) until updated. Splitting them leaves the build red between commits.

- [ ] **P.1** Add `packages/svelte-utils/src/google-sign-in.ts` exporting `getGoogleIdToken({ clientId }): Promise<{ provider: 'google'; idToken: { token: string; nonce: string } }>`. Add the export entry to `packages/svelte-utils/package.json` so consumers import as `@epicenter/svelte/google-sign-in`. Browser-only (DOM-dependent); throws `AuthError.SocialSignInUnavailable` when GIS fails to load.
- [ ] **P.2** Update `signInWithIdToken` parameter type in `packages/auth/src/create-auth.ts` to derive `idToken` from Better Auth's `signIn.social` parameter (see "Type derivation pattern" above). Constrain `provider` to the OIDC literal union (`'google' | 'apple' | 'microsoft' | 'facebook' | 'cognito' | 'line' | 'paypal'`). Add `SocialSignInUnavailable` to the `AuthError` union.
- [ ] **P.3** Update `apps/tab-manager` (the only existing caller of `signInWithIdToken`) to the new nested shape, in the same commit.
- [ ] **P.4** Update `packages/auth/src/create-auth.test.ts` and any mocks to the nested shape.
- [ ] **P.5** Verification: `bun run --filter @epicenter/auth typecheck`, `bun run --filter @epicenter/svelte typecheck`, `bun run --filter tab-manager typecheck`, `bun test packages/auth/src/create-auth.test.ts`.

### Per-app waves (any order after P; each ships independently)

For each of `apps/{dashboard,fuji,honeycrisp,opensidian,zhongwen}`:

- [ ] **A.1** Add the app's Google client ID to its env config (if not already present).
- [ ] **A.2** Replace the sign-in button handler with `await auth.signInWithIdToken(await getGoogleIdToken({ clientId: env.GOOGLE_CLIENT_ID }))`, importing `getGoogleIdToken` from `@epicenter/svelte/google-sign-in`.
- [ ] **A.3** Drop the `callbackURL` flow and any redirect-listener side effects. Catch `AuthError.SocialSignInUnavailable` and surface a clear UI message.
- [ ] **A.4** Add a sign-in smoke test (manual or e2e) that verifies the popup completes and identity lands.
- [ ] **A.5** Per-app verification: `bun run --filter <app> typecheck` and a manual sign-in pass.

### Final wave (after all per-app PRs land)

- [ ] **F.1** Drop `signInWithSocialRedirect` from `AuthClient` in `packages/auth/src/create-auth.ts`.
- [ ] **F.2** Confirm `SocialSignInFailed` stays. Only its producer changes (now solely `signInWithIdToken`); the variant shape and name are unchanged. `SocialSignInUnavailable` is the new sibling variant for GIS-blocked browsers.
- [ ] **F.3** Update tests and mocks in `packages/auth/src/create-auth.test.ts`.
- [ ] **F.4** Update `.claude/skills/auth/SKILL.md` to describe `signInWithIdToken` as the only social path and document the per-flow framing.
- [ ] **F.5** Grep `signInWithSocialRedirect` across `apps/` and `packages/`. Should match only this spec and the historical unified-client spec.

## Edge cases

### One-tap eligibility

GIS one-tap requires:
- FedCM-eligible browser (Chrome 117+, default on) or third-party cookies enabled (older browsers).
- User signed into a Google account in the browser.
- Origin registered in the Google Cloud OAuth client config.

Apps should fall back to the popup if one-tap is suppressed. The `getGoogleIdToken()` helper handles this internally; the call site sees one promise.

### GIS blocked or unavailable

Brave's default privacy settings block the GIS iframe. Some users block `accounts.google.com/gsi/client` via filter lists. The `getGoogleIdToken()` helper:

- Detects when the GIS SDK fails to load or the popup returns no credential.
- Throws `AuthError.SocialSignInUnavailable` (added to the `AuthError` union in P.2).
- The sign-in UI catches the variant and surfaces a clear message: "Sign-in is unavailable in this browser. Try Chrome, Edge, or Safari."

Picking a single approach for v1: **fail loud.** A future enhancement could fall back to navigating the user to the API-hosted page (`https://api.epicenter.so/sign-in?callbackURL=...`), which uses a top-level redirect that is not subject to the same iframe blocking. That fallback works cleanly for cookie-auth apps; bearer apps (opensidian) would need additional handoff logic to receive the bearer token from the API page (see Future direction).

### Popup blockers

The popup must be triggered from a user gesture (click handler). Spec the helper to throw if invoked outside a gesture context.

### Nonce handling

Better Auth verifies the nonce server-side. The helper generates the nonce, stores it in memory for the duration of the sign-in attempt, and passes it along.

### FedCM transition

Chrome is migrating GIS one-tap to FedCM. The GIS SDK abstracts this transition; pin to a recent SDK version and re-test annually.

### Existing redirect callback URLs

When apps remove `callbackURL`, any saved deep-links the redirect path used must be persisted via app-local routing instead (e.g., `localStorage` `redirectAfterSignIn` key), not via the auth flow.

## Provider scope

The launch set, grounded in research across 20 comparable productivity/dev tools (Notion, Linear, Cursor, Vercel, Cloudflare, Supabase, Raycast, Granola, Reflect, Slack, Figma, Discord, Loom, Claude, GitHub, Render, Railway, Neon, etc.):

| Provider | Flow | Status in this spec |
|---|---|---|
| Google | OIDC → `signInWithIdToken` | Active. Configured server-side; minted client-side via GIS popup (browser SPAs) or `chrome.identity.launchWebAuthFlow` (extension). |
| Apple | OIDC → `signInWithIdToken` | Type-supported; not yet configured server-side. Adding it is a `socialProviders.apple` config block + "Sign in with Apple JS" client SDK in the same `@epicenter/svelte/google-sign-in` neighborhood. No new flow needed. |
| GitHub | OAuth code (non-OIDC) | Cookie SPAs: navigate to API-hosted page (`window.location.href = '/sign-in?provider=github'`); the API's existing redirect flow handles it. Bearer apps (opensidian, tab-manager, future Tauri): supported via OAuth 2.1 PKCE client pattern routed through the existing `oauthProvider()` plugin (the same one that powers the CLI today). See "Future direction". |
| Magic link / email OTP | Passwordless email → separate flow method | Separate future spec. Better Auth has a first-class `magicLink()` plugin. Adopting it would add `signInWithMagicLink({ email })` as a new flow method. Not blocking this spec. |
| Microsoft Entra ID | OIDC-compatible if added | Skip at launch. Research showed first-party Sign-In-With-Microsoft buttons are rare (3/20 apps); Microsoft users typically arrive via SAML at the enterprise tier. Add when an enterprise customer asks. |
| Discord, Slack, GitLab, Bitbucket, Facebook, X, LinkedIn, etc. | Various | Out of scope. Niche outside specific verticals. Add when a real user asks. |
| Passkey (WebAuthn) | Separate flow method | Defer to 2026. Adoption is real but early (3/20 apps). Better Auth has a `passkey()` plugin ready when adoption catches up. |
| SAML / SSO | Separate flow | Out of scope. Add when an enterprise deal needs it. |

Why this set is "small but comprehensive" rather than "comprehensive":

- **Adding more OIDC providers within `signInWithIdToken` is free** (config + a string in the union). Apple is one config block away.
- **Adding a non-OIDC provider crosses a boundary**: the AuthClient surface needs a second flow method for bearer environments. That boundary already exists (the API-hosted page handles GitHub for cookie SPAs); the bearer-environment version is the OAuth 2.1 client pattern via existing `oauthProvider()` (Future direction).
- **Per the research**, the dev-infra consensus is GitHub + Google + email; the broader productivity consensus is Google + Apple + email. Epicenter's positioning hits both, hence Google + GitHub + Apple + (future) magic link.

## Future direction

This spec ships a small surface that fits today. Three additions are pre-named so future specs slot in without churn:

1. **Magic link** (`signInWithMagicLink({ email, callbackURL? })`). Better Auth's `magicLink()` plugin. Modern passwordless trend (Linear, Claude, Reflect went password-free). Separate spec.
2. **Apple OIDC**. Just a `socialProviders.apple` server config + client SDK helper in `@epicenter/svelte/sign-in-apple`. No surface change; reuses `signInWithIdToken`. Trivial follow-on once an Apple Developer account is set up.
3. **OAuth 2.1 PKCE client pattern for bearer apps** (separate spec, blocks behind the [Better Auth 1.6.9 upgrade](https://github.com/epicenterhq/havana/blob/main/specs/20260504T210000-better-auth-1.6.9-upgrade.md)). Closes the bearer + non-OIDC gap by reusing the **existing** `@better-auth/oauth-provider` plugin already deployed on `apps/api` (currently powers the epicenter CLI's PKCE login). Each bearer app becomes an OAuth 2.1 client of `api.epicenter.so`: user signs in on the API-hosted page (using ANY provider configured server-side: Google, GitHub, Apple, Discord, magic link, etc.); API issues an authorization code; client exchanges via PKCE for an access token; client uses access token as bearer.

   **Per-environment transports** (verified via DeepWiki against WXT, Tauri, and Better Auth source):

   | Bearer app | Transport | Library |
   |---|---|---|
   | opensidian (cross-origin SPA) | Full-page redirect (NOT popup) | [`oauth4webapi`](https://github.com/panva/oauth4webapi). `code_verifier` in `sessionStorage`. |
   | tab-manager (Chrome extension MV3) | `chrome.identity.launchWebAuthFlow` from background service worker | `oauth4webapi`. `code_verifier` in `chrome.storage.session`. Redirect URI `https://<EXTID>.chromiumapp.org/`. Pin extension ID via manifest `key`. |
   | whispering (future Tauri 2.x) | **Localhost loopback** (NOT custom-scheme deep link) | [`tauri-plugin-oauth`](https://github.com/FabianLars/tauri-plugin-oauth) (FabianLars) + the [`oauth2`](https://docs.rs/oauth2/) Rust crate. Sidesteps every macOS/Linux deep-link footgun (no Info.plist edits, no `.desktop` files, no first-launch chicken-and-egg). This is what `gh auth login` and the Google Cloud SDK ship. |

   **Does NOT replace `signInWithIdToken`**: the OIDC fast path stays as the in-page popup route (~1s UX) for cookie SPAs and tab-manager Google sign-in. OAuth 2.1 client is the universal-provider path (~3-5s system-browser/popup hop) for bearer + non-OIDC.

   **Estimated 3-5 days** of focused work for the OAuth client adapters (vs the 1-2 weeks a custom handoff plugin would need). Reuses Better Auth primitives end-to-end. No new server endpoints. **Pre-flight risk to verify with one integration test before committing**: confirm Better Auth's `bearer()` plugin validates JWT-signed tokens issued by `oauthProvider()`. Per the research grilling, the bearer plugin's signature path may be HMAC-with-app-secret while oauthProvider issues asymmetric JWTs by default; if so, configure `jwt()` for HMAC or add a tiny resource-server middleware. Fix is "<1 day if needed" per the research.

   **Dependencies**: Better Auth 1.6.0+ for RFC 8252 loopback redirect URI matching (Tauri); benefits from 1.6.7 for multi-client-id idToken support (per-platform Google client IDs across web/extension/Tauri). Both ship in the 1.6.9 upgrade spec.

   Build trigger: any bearer app needs a non-OIDC provider (GitHub, Discord, etc.), OR opensidian's GIS-blocked-browser failure mode becomes a real user report.

## Alternatives considered

The path here was not the only option. Briefly, what was rejected and why:

- **Per-provider methods** (`signInWithGoogle`, `signInWithGitHub`, etc.). Doesn't match Better Auth's idiom. AuthClient surface grows linearly with providers. Conflates provider with flow. Two providers in the same flow shape (Google + Apple, both OIDC) deserve one method, not two.
- **Drop AuthClient sign-in methods entirely**, expose Better Auth client directly. Bearer token would leak out of the auth construction boundary; the wrapper exists specifically to keep transport details below the public surface.
- **Build a custom unified handoff plugin from scratch.** An earlier draft considered an `@epicenter/auth-handoff` server plugin + per-environment client adapters (one server-side PKCE + redirect_token + exchange endpoint, three thin client adapters). The grilling pass surfaced the better answer: the existing `@better-auth/oauth-provider` already implements OAuth 2.1 PKCE on the server (powers the CLI today). Wrapping it from each app via standard OAuth 2.1 client libraries (`oauth4webapi` for browser/extension; `oauth2` Rust crate for Tauri) is 2-3x less work, uses Better Auth primitives end-to-end, and avoids becoming the maintainer of bespoke auth code. See Future direction item 3.
- **Daveyplate's lighter Tauri pattern** (`@daveyplate/better-auth-tauri`) as the universal answer. Doesn't generalize: it depends on cookie sharing between the system browser and the Tauri webview (which doesn't exist for Chrome extensions or cross-origin bearer SPAs). Even for Tauri specifically, the OAuth 2.1 PKCE + localhost loopback pattern is more reliable than daveyplate's deep-link approach (no platform-specific deep-link quirks).
- **Tauri custom-scheme deep link** (e.g. `whispering://callback`) for the future Tauri OAuth client. Rejected in favor of localhost loopback: deep links are full-on Windows/Linux but partial on macOS/iOS (must register at config-time, no runtime dynamic registration), and the loudest footgun in the stack per the research. Loopback (`tauri-plugin-oauth`) sidesteps every platform quirk: no Info.plist edits, no `.desktop` file dance, no Windows registry, no single-instance plugin, no first-launch chicken-and-egg. It's what `gh auth login`, Google Cloud SDK, and most desktop OAuth clients ship.
- **Microsoft as a launch-set provider.** Research said no; first-party Sign-In-With-Microsoft is rare (3/20 apps). Reach Microsoft users via SAML when enterprise demand surfaces.
- **A new dedicated `@epicenter/social-sign-in-browser` package.** Earlier draft of this spec. The grilling pass surfaced that one ~30 LOC helper doesn't earn a new package; sub-export from the existing `@epicenter/svelte` is enough.
- **Use `@daveyplate/better-auth-tauri` as whispering's auth path.** Earlier draft suggested this for ~1 day of work. The OAuth 2.1 PKCE + localhost loopback pattern via existing `oauthProvider()` is preferred because (a) it's the same pattern the CLI already uses, (b) loopback is more reliable than deep-link across macOS/Linux, (c) reuses Better Auth primitives end-to-end with no community-plugin maintenance dependency. See Future direction item 3.

## Deferred (not open)

- **Tauri auth path.** GIS does not work inside the Tauri webview (Google won't register `tauri://localhost` as a valid OAuth origin). When whispering adds auth, the path is the OAuth 2.1 PKCE client pattern via the existing `@better-auth/oauth-provider` plugin (Future direction item 3): system browser opens `api.epicenter.so/auth/oauth2/authorize?...&redirect_uri=http://127.0.0.1:RANDOMPORT/callback`, user signs in on the API page (any provider), `tauri-plugin-oauth` (FabianLars) spawns an ephemeral local HTTP server to capture the redirect, `code_verifier` lives in Rust state inside the Tauri command that started the flow, exchange via `oauth2` Rust crate. ~1-2 days of integration work. NOT a change to `AuthClient`; it's whispering's local sign-in helper plus a one-time oauthProvider client registration server-side. The `@daveyplate/better-auth-tauri` deep-link plugin was considered and rejected (see Alternatives considered).

## Success criteria

- [ ] Every browser app calls `auth.signInWithIdToken`.
- [ ] No source file imports `signInWithSocialRedirect`.
- [ ] `AuthClient` does not declare `signInWithSocialRedirect`.
- [ ] `SocialSignInFailed` is unchanged; its only producer is `signInWithIdToken`.
- [ ] All affected app typechecks pass.
- [ ] Manual smoke: each migrated app completes sign-in via popup.

## Verification commands

```sh
bun run --filter @epicenter/auth typecheck
bun run --filter @epicenter/svelte typecheck
bun run --filter dashboard typecheck
bun run --filter fuji typecheck
bun run --filter honeycrisp typecheck
bun run --filter opensidian typecheck
bun run --filter zhongwen typecheck
bun run --filter tab-manager typecheck
bun test packages/auth/src/create-auth.test.ts
```

## Straggler searches

```sh
rg -n "signInWithSocialRedirect" apps packages -S
rg -n "SocialSignInFailed.*redirect" apps packages -S
rg -n "callbackURL" apps packages -S    # Better Auth's redirect param
```

After implementation, the first two should match only historical specs. The third may still match unrelated callbackURL uses; manually confirm none are auth-related.
