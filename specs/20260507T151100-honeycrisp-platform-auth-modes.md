# Honeycrisp Platform Auth Modes

**Date**: 2026-05-07
**Status**: Draft
**Author**: AI-assisted

## Overview

Honeycrisp needs platform-selected auth. The hosted web app can use cookies on `*.epicenter.so`, while desktop and localhost development should be able to use bearer auth without mixing browser cookies into the same runtime.

One sentence: Honeycrisp should choose cookie or bearer auth at the platform boundary, then enforce that choice for the whole app instance.

## Motivation

### Current State

Honeycrisp currently constructs auth from a shared app module:

```ts
// apps/honeycrisp/src/lib/auth.ts
export const auth = createBearerAuth({
	baseURL: APP_URLS.API,
	sessionStorage: createPersistedState({
		key: 'honeycrisp:authSession',
		schema: BearerSession.or('null'),
		defaultValue: null,
	}),
});
```

That is correct for a standalone bearer runtime. It is not enough for a product that may run as:

```txt
production web   https://honeycrisp.epicenter.so
local web        http://localhost:5175
desktop          Tauri shell
```

This creates problems:

1. **Production web and development want different defaults**: Production subdomain web can rely on `.epicenter.so` cookies. Localhost development cannot rely on those cookies unless the dev server runs on an `.epicenter.so` host.
2. **Desktop should not inherit browser assumptions**: Desktop needs bearer auth backed by native storage or a preloaded synchronous adapter.
3. **One shared module hides platform facts**: The app imports `$lib/auth` and cannot tell whether the current runtime is cookie-backed or bearer-backed.
4. **Mixed auth is tempting during OAuth**: OAuth redirect flows often create an API cookie first. Bearer runtimes need an explicit handoff or cleanup path so they do not carry both cookie and bearer credentials.

### Desired State

Shared Honeycrisp UI imports one stable auth entrypoint:

```ts
import { auth } from '$platform/auth';
```

Each platform module chooses exactly one credential owner:

```txt
hosted web on *.epicenter.so
  createCookieAuth(...)
  browser cookie jar owns the credential

localhost web
  createBearerAuth(...)
  localStorage owns the bearer session

desktop
  createBearerAuth(...)
  native storage owns the bearer session
```

The API keeps rejecting mixed credentials. Platform auth prevents normal app code from producing them.

## Research Findings

### Better Auth Transport

Better Auth's browser client defaults to `credentials: "include"`. That is the right default for cookie auth and the wrong default for bearer auth. The companion spec `20260507T151049-bearer-client-omit-internal-cookies.md` fixes the core bearer guardrail by setting `credentials: 'omit'` inside `createBearerAuth()`.

### Cookie Auth on Epicenter Subdomains

The API config already scopes cookies to `.epicenter.so`:

```ts
advanced: {
	crossSubDomainCookies: {
		enabled: true,
		domain: '.epicenter.so',
	},
	defaultCookieAttributes: {
		sameSite: 'none',
		secure: true,
	},
}
```

That means `https://honeycrisp.epicenter.so` can use cookie auth against `https://api.epicenter.so`. Separate origin does not force bearer auth when both hosts are first-party subdomains.

### Bearer Auth for Localhost and Desktop

Localhost is not under `.epicenter.so`. Cookie auth can still work in some local setups if the API allows localhost origins and the browser accepts the cookie flow, but it creates more browser-policy surface area than bearer auth. Desktop has the same conclusion for a stronger reason: the app should own a token in native storage instead of leaning on a browser cookie jar.

### Vite Platform Aliasing

The OpenSidian platform alias spec already describes the right boundary:

```txt
$platform/auth -> src/lib/platform/auth/live.web.ts
$platform/auth -> src/lib/platform/auth/live.local.ts
$platform/auth -> src/lib/platform/auth/live.desktop.ts
```

Vite resolves aliases before traversing the target module graph, so desktop-only imports do not enter the web build and web-only storage does not enter the desktop build.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Mixed credentials | 2 coherence | Keep rejecting them at the API | Mixed auth hides precedence and can bind the app to the wrong session. |
| Hosted web auth | 2 coherence | Use cookie auth for `honeycrisp.epicenter.so` | The API cookie is scoped to `.epicenter.so`, so the browser cookie jar is the clean credential owner. |
| Localhost auth | 3 taste | Prefer bearer auth by default | It avoids requiring a local `.epicenter.so` host and mirrors desktop more closely. |
| Desktop auth | 2 coherence | Use bearer auth | Desktop should own a durable token in native storage. |
| Platform selection | 2 coherence | Use `$platform/auth` alias | Shared UI should consume `AuthClient`, not transport facts. |
| Cookie cleanup for bearer OAuth | Deferred | Design with the handoff flow | Clearing cookies is part of the OAuth handoff, not a side effect inside generic auth construction. |

## Architecture

```txt
Honeycrisp shared UI
  |
  v
$platform/auth
  |
  |-- hosted web
  |     createCookieAuth({ baseURL: APP_URLS.API })
  |
  |-- localhost web
  |     createBearerAuth({ sessionStorage: localStorage adapter })
  |
  `-- desktop
        createBearerAuth({ sessionStorage: native adapter })
```

The workspace session stays unchanged:

```ts
const honeycrisp = openHoneycrisp({
	userId,
	peer,
	bearerToken: () => auth.bearerToken,
	encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
});
```

For cookie auth, `auth.bearerToken` returns `null`, so WebSocket sync sends no bearer subprotocol. For bearer auth, sync sends `bearer.<token>`.

## OAuth Handoff Shape

Bearer OAuth needs an explicit bridge from API cookie to bearer session:

```txt
1. User starts Google sign-in from a bearer runtime.
2. API completes OAuth and sets the temporary Better Auth cookie.
3. Runtime calls a handoff endpoint with cookie credentials only.
4. API returns the custom session plus set-auth-token.
5. API clears the cookie without revoking the bearer session.
6. Runtime stores BearerSession and continues with credentials omit.
```

This is not needed for hosted cookie web. In that runtime, the cookie is the credential and should stay.

## Implementation Plan

### Phase 1: Platform Entry Point

- [ ] **1.1** Add Honeycrisp `$platform/auth` alias entries for hosted web, local web, and desktop.
- [ ] **1.2** Move the current bearer auth module into the local web platform module.
- [ ] **1.3** Add hosted web auth with `createCookieAuth({ baseURL: APP_URLS.API })`.
- [ ] **1.4** Update shared Honeycrisp imports from `$lib/auth` to `$platform/auth`.
- [ ] **1.5** Keep the public `AuthClient` surface unchanged for sessions and components.

### Phase 2: Development Selection

- [ ] **2.1** Decide how scripts select hosted web versus local bearer mode.
- [ ] **2.2** Document the default developer flow.
- [ ] **2.3** If cookie-mode local dev is supported, document the required `.epicenter.so` host setup.

### Phase 3: Desktop Storage

- [ ] **3.1** Define a desktop bearer session storage adapter.
- [ ] **3.2** Preload async native storage before constructing `createBearerAuth()`.
- [ ] **3.3** Keep the adapter synchronous at the auth factory boundary.

### Phase 4: Bearer OAuth Handoff

- [ ] **4.1** Design the handoff endpoint shape.
- [ ] **4.2** Return a validated custom session and expose `set-auth-token`.
- [ ] **4.3** Clear the API cookie after handoff without revoking the session.
- [ ] **4.4** Add a dev diagnostic for `multiple_credentials` that explains which credential to clear.

## Verification

Platform builds should prove the import graph:

```sh
bun run --filter @epicenter/honeycrisp typecheck
bun run --filter @epicenter/honeycrisp build
```

Auth behavior should be checked with browser DevTools:

```txt
hosted web request:
  Cookie present
  Authorization absent

local bearer request:
  Cookie absent
  Authorization present

mixed request:
  API returns multiple_credentials
```

## Open Questions

1. Should local bearer OAuth use the same handoff endpoint as desktop?
2. Should hosted web ever support bearer mode, or should bearer be reserved for localhost and desktop?
3. Should the sign-in UI show a recovery action when `multiple_credentials` happens, or should the console diagnostic be enough for development?

## Review Checklist

Before implementing this spec, run a skeptical pass over the auth split:

1. Read `packages/auth/src/create-auth.ts`, `packages/auth/src/create-auth.test.ts`, `packages/auth/src/contract.test.ts`, `apps/api/src/auth/single-credential.ts`, `apps/honeycrisp/src/lib/auth.ts`, and the companion bearer credential spec.
2. List every file read as an ASCII tree before analysis.
3. Mentally inline helpers, wrappers, files, extracted functions, and platform modules back into their call sites.
4. Challenge whether the bearer credential tests are redundant or misplaced.
5. Challenge whether `createBearerAuth()` should own `credentials: 'omit'` directly, or whether `createAuthCore()` needs a stronger transport-specific config shape.
6. Challenge whether Honeycrisp hosted web should ever use cookie auth if the product may also become a desktop app.
7. Challenge the bearer OAuth handoff. Clearing the Better Auth cookie must clear only the browser credential, not revoke the session that backs the bearer token.
8. Report findings before editing. Do not silently fix structural concerns.

Useful verification for the review:

```sh
bun test packages/auth
bun run --filter @epicenter/auth typecheck
bun -e "const fs = require('fs'); for (const f of process.argv.slice(2)) fs.readFileSync(f, 'utf8').split(/\\n/).forEach((line, i) => { if (/[\\u2013\\u2014]/u.test(line)) console.log(f + ':' + (i + 1) + ':' + line); });" packages/auth/src/create-auth.ts packages/auth/src/create-auth.test.ts packages/auth/src/contract.test.ts specs/20260507T151049-bearer-client-omit-internal-cookies.md specs/20260507T151100-honeycrisp-platform-auth-modes.md
```

## Execution Brief

When this spec is ready to execute, use this closed task shape:

1. Read this spec, the companion bearer credential spec, the OpenSidian platform aliasing draft, Honeycrisp auth/session files, Honeycrisp Vite and SvelteKit config, `packages/auth/src/create-auth.ts`, `packages/svelte-utils/src/session.svelte.ts`, and `apps/api/src/auth/single-credential.ts`.
2. Add a `$platform/auth` entrypoint for Honeycrisp. A folder layout is preferred once more than one platform module exists:

```txt
apps/honeycrisp/src/lib/platform/auth/
|-- live.hosted-web.ts
|-- live.local-web.ts
`-- live.desktop.ts
```

3. Hosted web exports `auth = createCookieAuth({ baseURL: APP_URLS.API })` with the normal hot-dispose pattern.
4. Local web moves the current `createBearerAuth()` setup into the platform module, keeping the `honeycrisp:authSession` storage key.
5. Desktop uses bearer auth, but do not fake final desktop storage. Add the module only when the build config can select it without pulling desktop-only imports into the web graph. If storage is not ready, document the synchronous adapter requirement instead.
6. Add the alias so shared Honeycrisp code imports `auth` from `$platform/auth`.
7. Default localhost development to bearer mode. Use hosted cookie mode for production only if the existing scripts cleanly identify hosted web. If scripts do not distinguish these modes, update the spec before coding the alias.
8. Keep workspace construction unchanged except for the auth import. `bearerToken: () => auth.bearerToken` works for both modes because cookie auth returns `null`.
9. Do not implement OAuth handoff in the platform-alias pass unless the spec is updated first.

Run:

```sh
bun run --filter @epicenter/honeycrisp typecheck
bun run --filter @epicenter/honeycrisp build
```

If auth core changes during execution, also run:

```sh
bun test packages/auth
```
