# Drop Redirect Sign-In: Per-App Google Identity Services Migration

**Date**: 2026-05-04
**Status**: Draft
**Author**: AI-assisted (Claude)
**Branch**: TBD (per-app branches; ships independently)
**Depends on**: `specs/20260503T230000-auth-unified-client-two-factories.md` (Waves 1-6, implemented)

## One-Sentence Test

Each browser app mints a Google ID token via Google Identity Services and signs in through `signInWithIdToken`; `signInWithSocialRedirect` and its error producer disappear from the auth surface.

If any app still calls `signInWithSocialRedirect`, or the auth client still exposes it, the migration is not done.

## Overview

The unified-client spec (Waves 1-6) made `signInWithIdToken` first-class but kept `signInWithSocialRedirect` on the auth surface for backwards-compatibility while each browser app migrates its sign-in UI to Google Identity Services (GIS). This spec finishes that migration: each app gains a `getGoogleIdToken()` helper, swaps its sign-in call site, and the redirect method (and its `SocialSignInFailed` redirect-flow producer) is deleted from `AuthClient`.

The work ships per-app and finishes with one "delete the redirect" commit in `@epicenter/auth`.

## Why this is its own spec

The unified-client spec's thesis is *"`AuthClient` is the credential's lifecycle handle on this runtime; `createCookieAuth` and `createBearerAuth` produce the same interface, differing only in how they acquire, persist, and present the credential."* That thesis stays true today: `signInWithIdToken` is on the surface; `signInWithSocialRedirect` riding alongside doesn't contradict the unified shape.

This spec's thesis is different: per-app login UX migration to a third-party SDK. Different verbs, different scope (per-app vs auth-package), different layer. Per the cohesive-clean-breaks skill: when work ships independently and has its own sentence, it deserves its own spec.

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

Both methods proxy to Better Auth's `signIn.social()` with different args. The redirect path's `Result<undefined, AuthError>` Ok branch is unreachable because the page navigates away on success. Google supports OIDC ID tokens via GIS, so the redirect is structurally redundant.

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
  signIn(input): ...
  signUp(input): ...
  signInWithIdToken(input): ...      // ← only social path
  signOut(): ...
  // signInWithSocialRedirect: gone
  // ...
};
```

Each browser app:
1. Imports a local `getGoogleIdToken()` helper (per-app, since the GIS DOM init is app-specific).
2. Calls `auth.signInWithIdToken(await getGoogleIdToken())` from the sign-in button.
3. Drops the `callbackURL` and the redirect-flow listener.

`SocialSignInFailed`'s redirect producer is deleted from the auth error union.

## Per-app surface map

| App | Current sign-in | Migration target |
|---|---|---|
| dashboard | `signInWithSocialRedirect` | GIS popup |
| fuji | `signInWithSocialRedirect` | GIS popup |
| honeycrisp | `signInWithSocialRedirect` | GIS popup |
| opensidian | `signInWithSocialRedirect` | GIS popup |
| zhongwen | `signInWithSocialRedirect` | GIS popup |
| tab-manager | `signInWithIdToken` (already) | unchanged |
| whispering | none | unchanged |

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| GIS flow | Popup primary, one-tap secondary | Popup is reliable; one-tap improves return-user UX but has eligibility quirks (FedCM, third-party cookies). |
| Helper location | Per-app (`apps/<app>/src/lib/auth/get-google-id-token.ts`) | GIS init touches the DOM and the client ID is per-app deployment. |
| Nonce generation | `crypto.randomUUID()` per sign-in attempt | Prevents replay; required by Better Auth's `idToken` flow. |
| `signInWithSocialRedirect` removal | Delete after every browser app migrates | Hybrid would leave the dishonest method on the surface. |
| Wave order | Migrate apps first, delete from auth last | Otherwise apps break on next deploy. |

## Implementation plan

This spec ships per-app. Each app's migration is one PR; the final auth-package deletion is one PR after all browser apps are on GIS.

### Per-app waves (any order; each ships independently)

For each of `apps/{dashboard,fuji,honeycrisp,opensidian,zhongwen}`:

- [ ] **A.1** Add `apps/<app>/src/lib/auth/get-google-id-token.ts`. Returns `{ provider: 'google'; idToken: string; nonce: string }` via GIS popup. Uses the app's Google client ID from env config.
- [ ] **A.2** Update the sign-in button handler to `await getGoogleIdToken()` then call `auth.signInWithIdToken(token)`.
- [ ] **A.3** Drop the `callbackURL` flow and any redirect-listener side effects.
- [ ] **A.4** Add a sign-in smoke test (manual or e2e) that verifies the popup completes and identity lands.
- [ ] **A.5** Per-app verification: `bun run --filter <app> typecheck` and a manual sign-in pass.

### Final wave (after all browser apps migrate)

- [ ] **F.1** Drop `signInWithSocialRedirect` from `AuthClient` in `packages/auth/src/create-auth.ts`.
- [ ] **F.2** Drop `SocialSignInFailed`'s redirect-flow producer; collapse the error union.
- [ ] **F.3** Update tests and mocks in `packages/auth/src/create-auth.test.ts`.
- [ ] **F.4** Update `.agents/skills/auth/SKILL.md` to describe `signInWithIdToken` as the only social path.
- [ ] **F.5** Grep `signInWithSocialRedirect` across `apps/` and `packages/`. Should match only this spec and the historical unified-client spec.

## Edge cases

### One-tap eligibility

GIS one-tap requires:
- Third-party cookies enabled (or FedCM eligibility).
- User signed into a Google account in the browser.
- Origin registered in the Google Cloud OAuth client config.

Apps should fall back to the popup if one-tap is suppressed. The `getGoogleIdToken()` helper handles this internally; the call site sees one promise.

### Popup blockers

The popup must be triggered from a user gesture (click handler). Spec the helper to throw if invoked outside a gesture context.

### Nonce handling

Better Auth verifies the nonce server-side. The helper generates the nonce, stores it in memory for the duration of the sign-in attempt, and passes it along.

### FedCM transition

Chrome is migrating GIS one-tap to FedCM. The GIS SDK abstracts this transition; pin to a recent SDK version and re-test annually.

### Existing redirect callback URLs

When apps remove `callbackURL`, any saved deep-links the redirect path used must be persisted via app-local routing instead (e.g., `localStorage` `redirectAfterSignIn` key), not via the auth flow.

## Open questions

- Should the helper live in a shared package (`@epicenter/svelte-utils/google-sign-in`) instead of per-app? Argument for: each app would have ~30 LOC duplication. Argument against: GIS init is DOM-level and the client ID is per-deploy. Decision deferred to first app migration; if duplication is real, extract.
- Does GIS popup work inside the Tauri webview (whispering)? Out of scope for now (whispering doesn't sign in), but worth confirming before any future Tauri auth work.

## Success criteria

- [ ] Every browser app calls `auth.signInWithIdToken`.
- [ ] No source file imports `signInWithSocialRedirect`.
- [ ] `AuthClient` does not declare `signInWithSocialRedirect`.
- [ ] `SocialSignInFailed`'s error union has no redirect producer.
- [ ] All affected app typechecks pass.
- [ ] Manual smoke: each migrated app completes sign-in via popup.

## Verification commands

```sh
bun run --filter @epicenter/auth typecheck
bun run --filter dashboard typecheck
bun run --filter fuji typecheck
bun run --filter honeycrisp typecheck
bun run --filter opensidian typecheck
bun run --filter zhongwen typecheck
bun test packages/auth/src/create-auth.test.ts
```

## Straggler searches

```sh
rg -n "signInWithSocialRedirect" apps packages -S
rg -n "SocialSignInFailed.*redirect" apps packages -S
rg -n "callbackURL" apps packages -S    # Better Auth's redirect param
```

After implementation, the first two should match only historical specs. The third may still match unrelated callbackURL uses; manually confirm none are auth-related.
