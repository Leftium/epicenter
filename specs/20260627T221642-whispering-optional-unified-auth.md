# Whispering optional unified auth

**Date**: 2026-06-27
**Status**: Draft
**Owner**: Whispering / platform auth
**Branch**: (to start) feat/whispering-optional-auth, off `origin/main` (the #2220 merge that landed the vault)
**Relates**: [ADR-0079](../docs/adr/0079-whispering-authenticates-with-an-oauth-bearer-on-every-surface.md) (the transport decision this spec executes), [ADR-0074](../docs/adr/0074-the-secret-vault-is-an-owner-scoped-synced-store-encrypted-under-a-server-derived-keyring.md) (the vault that consumes the session keyring)

## One Sentence

Whispering adopts the monorepo's existing OAuth `SyncAuthClient` as an optional, non-gating session that yields `{ ownerId, fetch, keyring }`, so the ADR-0074 secret vault can activate, while signed-out Whispering stays exactly device-local.

## How to read this spec

```txt
Read first:
  One Sentence
  Motivation (Current State / Desired State)
  Design Decisions
  The session surface
  Implementation Plan
  Success Criteria

Read if changing the architecture:
  Research Findings
  Architecture
  Edge Cases
  Open Questions

Out of scope here:
  The vault wiring (facade routing, migration, UI badges, Vocab reuse) is the
  NEXT wave ("Wire the vault to the session"). This spec stops once
  `session.current.keyring` is live. It defines the seam that wave plugs into.
```

## Overview

This spec adds an optional authenticated session to Whispering, built on `@epicenter/auth` exactly as the extension and CLI use it, plus a new server endpoint that delivers the per-owner keyring ADR-0074 requires. It changes no signed-out behavior. When the work lands, a signed-in Whispering exposes `session.current = { ownerId, fetch, keyring }`; a signed-out Whispering exposes `session.current = null` and every secret stays device-local.

## Motivation

### Current State

Whispering has no auth. The secret-vault facade reads device-local plaintext and says so in its own JSDoc (`apps/whispering/src/lib/state/secrets.svelte.ts`):

```ts
// apps/whispering/src/lib/state/secrets.svelte.ts
export function createSecrets() {
	return {
		get(key: SecretKey): SecretRead {
			const value = deviceConfig.get(key);
			return value ? { status: 'available', value } : { status: 'missing' };
		},
		set(key: SecretKey, value: string): void {
			deviceConfig.set(key, value);
		},
	};
}
export const secrets = createSecrets();
```

The facade's auth-seam JSDoc already spells out what is waiting: "When auth lands, the session delivers a server-derived per-owner keyring (`HKDF(rootSecret, ownerId)` through `@epicenter/encryption`'s `deriveKeyring`)."

The vault primitives exist and are tested, but the keyring has no producer:

- `createEncryptedYkvLww<T>(ydoc, arrayKey)` starts in passthrough (plaintext) mode; `kv.activateEncryption(keyring)` flips it and re-encrypts existing plaintext (`packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`).
- `deriveKeyring({ rootKeyring, label })` derives a per-owner `Keyring` from a root keyring parsed from `env.ENCRYPTION_SECRETS` (`packages/encryption/src/derivation.ts`).
- `deriveKeyring` has **zero callers** outside the encryption package, and there is **no keyring-delivery endpoint** anywhere in `packages/server` or `apps/api`.

### Problems

1. **The vault cannot activate.** ADR-0074 shipped the encrypted home in its safe degenerate (device-local plaintext) and explicitly deferred activation to "when auth lands." Nothing can call `activateEncryption` because no session delivers a keyring.
2. **No keyring producer exists.** `deriveKeyring` is tested but never called; the server has no endpoint that runs it for the signed-in owner.
3. **Whispering risks growing its own auth.** Different surfaces in the monorepo authenticate differently (cookie vs bearer, same-origin vs OAuth). Whispering is both a web app and a Tauri app, so without a decision it could invent a third pattern.

### Desired State

```ts
// apps/whispering/src/lib/session.ts  (Shape B: additive, non-gating overlay)
export const session = createSession({ auth, build });
// session.current === null            -> signed out, vault facade reads device-local
// session.current === { ownerId, fetch, keyring }
//                                     -> signed in, vault facade can activate
```

Signed-out is the unchanged safe degenerate. Signed-in yields the exact triple the facade's JSDoc names.

## Research Findings

### How every signed-in surface authenticates today

Surveyed `packages/auth`, `apps/api/ui`, `apps/tab-manager`, and `packages/cli`.

| Surface | Transport | Origin model | Storage | Sync-capable? |
| --- | --- | --- | --- | --- |
| Dashboard (`apps/api`) | httpOnly cookie | same-origin under `api.epicenter.so` | browser cookie | No (`AuthClient`, no `openWebSocket`) |
| Extension (`tab-manager`) | OAuth/PKCE bearer | redirect via `browser.identity` | `chrome.storage.local` | Yes (`SyncAuthClient`) |
| CLI (hosted) | OAuth/PKCE bearer | OOB code flow | `~/.local/share/.../<host>.json` (0600) | Yes |
| CLI / star (self-host) | static bearer | none (config) | env (`EPICENTER_TOKEN[_FILE]`) | Yes |

**Key finding:** there is already one unified contract. `createAppAuthClient(instance, opts)` branches on the instance (no `token` -> `createOAuthAppAuth` hosted PKCE; `token` -> `createInstanceTokenAuth` self-host) and both return a `SyncAuthClient` exposing `state` (`{ status, ownerId }`), an audience-scoped `fetch`, `openWebSocket`, `startSignIn`, `signOut`, `onStateChange`. Whispering does not need a new client; it needs to construct this one.

**Implication:** the only real divergence is cookie (dashboard, same-origin, no sync) vs bearer (everything cross-origin, sync). Whispering's web build is cross-origin from the api (`whispering.epicenter.so` is not `api.epicenter.so`), and Whispering needs sync. So Whispering is in the bearer bucket.

### The cookie-vs-bearer resolution (consulted Codex)

The honest split is whether the web build should re-host under the api origin to get an XSS-safe httpOnly cookie. Resolved to OAuth bearer everywhere (ADR-0079). Two findings, independently confirmed by Codex, make this more than a convenience choice:

1. **`createSession` rejects a cookie client.** It requires a `SyncAuthClient`; its own JSDoc says "A same-origin cookie client is a plain `AuthClient` and cannot be passed here." Cookie auth for Whispering would mean inventing a cookie-authenticated sync path: a third pattern.
2. **A cookie does not protect a JS-decrypted vault.** The keys and keyring are decrypted in JS regardless of login transport; an XSS hole reads them out of the running app whether the credential is a cookie or a bearer. So the cookie's main benefit is largely moot for this app.

Hardening lives inside the bearer choice (sessionStorage/memory grant on web, short-lived tokens, CSP), not a transport switch. See ADR-0079 for the full rationale and rejected alternatives.

### Where the session singleton lives

Per `workspace-app-composition`: Whispering is a Shape B app with a `src-tauri/` directory, so its composition files nest under `src/lib/workspace/` and it uses the `#platform/*` build seam. The session singleton is `apps/whispering/src/lib/session.ts` (a plain `.ts` module, not `.svelte.ts`). Auth client construction lives behind `#platform/auth`. The main recordings workspace is built eagerly in the browser factory and gates first paint in a route `load` on `whenReady`; the auth session must not change that.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Auth transport for all surfaces | 2 coherence | OAuth bearer (`SyncAuthClient`) everywhere; web stays own origin | ADR-0079. Cookie cannot sync and does not protect a JS-decrypted vault. |
| Auth client | 1 evidence | `createAppAuthClient(instance, { clientId, launcher, persistedAuthStorage })` | Verified: same client tab-manager/CLI use; returns `SyncAuthClient`. No new type. |
| Platform selection | 2 coherence | `#platform/auth` provides `{ launcher, persistedAuthStorage }`; Tauri = deep-link + keychain, web = redirect + sessionStorage/memory | Matches the existing `#platform/*` seam; only launcher + storage differ per build. |
| Session shape | 2 coherence | Additive, non-gating singleton in `src/lib/session.ts`; owns the vault doc + keyring only | Whispering stays Shape B; auth never gates the device-local workspace (ADR-0074 safe degenerate). |
| Keyring delivery | 2 coherence | New authenticated server endpoint derives + returns the per-owner `Keyring`; client never sees `rootKeyring` | ADR-0074 invariant 1: keyring lives in the auth service, delivered over the session. |
| Session keyring seam | 3 taste | Extend `SignedIn` with `fetch: AuthFetch`; Whispering's `build` fetches the keyring | Minimal additive seam; Whispering is the first/only consumer, so keyring logic stays app-side, not forced on every app. |
| Self-host keyring | 2 coherence | Self-host derives with the operator's own `ENCRYPTION_SECRETS` root | ADR-0075: self-host is one pinned partition (`owners/instance`) behind one operator bearer; Epicenter is never in the loop. Every caller resolves to the same `INSTANCE_OWNER_ID`, so the derived keyring is shared across whoever holds the instance token, matching the single-partition model. |
| Web grant storage | 3 taste | `sessionStorage` or memory, never `localStorage`; Tauri keychain | ADR-0079 hardening. Trade repeat sign-in for a smaller XSS blast radius. |
| Vault doc attach + activation | Deferred | Deferred to the next wave | This spec stops at `session.current.keyring`; the vault wiring is "Wire the vault to the session". |

## Architecture

### Layers (signed in)

```txt
#platform/auth  ->  { launcher, persistedAuthStorage }   (per build: tauri vs web)
       |
createAppAuthClient(instance, { clientId, launcher, persistedAuthStorage })
       |  -> SyncAuthClient { state, fetch, openWebSocket, startSignIn, signOut }
       |
createSession({ auth, build })
       |  build(signedIn: { server, baseURL, ownerId, fetch, openWebSocket, ... })
       |     -> fetch GET /api/keyring (bearer-attached) -> Keyring
       |     -> returns a Disposable session payload { ownerId, fetch, keyring }
       v
session.current : { ownerId, fetch, keyring } | null
                   ^ the seam the vault wave consumes
```

### Keyring delivery sequence

```txt
client (signed in)                 server (auth service, holds ENCRYPTION_SECRETS)
  signedIn.fetch GET /api/keyring  ->  authenticate owner from bearer (ADR-0067)
                                       rootKeyring = parseRootKeyring(env.ENCRYPTION_SECRETS)
                                       keyring = deriveKeyring({ rootKeyring, label: ownerId })
  Keyring  <----------------------     respond { keyring }   (per-owner key material, base64)
  session holds keyring
  (next wave) vault.activateEncryption(keyring)
```

The client receives only the derived `Keyring` (`{ version, keyBytesBase64 }[]`), never the root. Self-host runs the same endpoint with the operator's own `ENCRYPTION_SECRETS`.

### Two independent doc lifecycles

```txt
recordings workspace   eager, device-local, built in browser factory   UNCHANGED
secret vault doc       attached on sign-in, disposed on sign-out        NEXT WAVE
```

The auth session owns the second lifecycle only. The first never depends on auth.

## The session surface (the seam the vault wave consumes)

```ts
// apps/whispering/src/lib/session.ts
import { createAppAuthClient, createSession } from '@epicenter/svelte/auth';
import { authPlatform } from '#platform/auth';  // { launcher, persistedAuthStorage }
import { whisperingInstance } from '$lib/auth/instance'; // Wave 1 adds this; see 1.0

// Whispering has no instance setting on main today. Wave 1 establishes the
// Instance: the hosted default { baseURL: 'https://api.epicenter.so' }, or a
// self-host { baseURL, token }. createAppAuthClient branches on instance.token.
const auth = createAppAuthClient(whisperingInstance.current, {
	clientId: WHISPERING_CLIENT_ID,
	launcher: authPlatform.launcher,
	persistedAuthStorage: authPlatform.persistedAuthStorage,
});

export const session = createSession({
	auth,
	// build runs once per identity-bearing state, disposed on sign-out.
	build: (signedIn) => openSecretSession(signedIn),
});

export type SecretSession = {
	ownerId: OwnerId;
	fetch: AuthFetch;            // audience-scoped, bearer-attached
	keyring: Keyring | null;    // null until /api/keyring resolves; then populated
	[Symbol.dispose](): void;
};
```

`session.current` is `SecretSession | null`. The vault wave reads `session.current?.keyring` to attach and `activateEncryption` the vault doc, and routes the facade to the vault when a keyring is present (else device-local).

## Implementation Plan

Build, Prove, then hand off. There is no old path to remove: this is purely additive.

### Wave 1: client session (no keyring yet)

- [ ] **1.0** Establish the Whispering `Instance` (`$lib/auth/instance`). Whispering has no instance setting on main today: default to the hosted instance `{ baseURL: 'https://api.epicenter.so' }`, with an optional self-host `{ baseURL, token }`. Mirror the `*-instance-setting` pattern other apps use; `createAppAuthClient` branches on `instance.token`.
- [ ] **1.1** Add the `#platform/auth` seam: `platform/auth/types.ts` contract `{ launcher, persistedAuthStorage }`; `auth.browser.ts` (redirect launcher + sessionStorage/memory `PersistedAuthStorage`) and `auth.tauri.ts` (deep-link launcher + keychain storage). Declare in `package.json` "imports".
- [ ] **1.2** Register a Whispering OAuth client (`WHISPERING_CLIENT_ID`) against the hosted star; wire the redirect/deep-link callback routes.
- [ ] **1.3** Create `apps/whispering/src/lib/session.ts`: construct `auth` via `createAppAuthClient(whisperingInstance.current, ...)`, then `session = createSession({ auth, build })` where `build` returns a minimal `SecretSession` (`{ ownerId, fetch, keyring: null, [Symbol.dispose] }`).
- [ ] **1.4** Minimal sign-in / sign-out UI (an account menu entry). Signed-out shows "Sign in"; no gate anywhere.
- [ ] **1.5** Prove: signed-out Whispering is byte-for-byte unchanged (device-local). Sign in -> `session.current.ownerId` populated. Sign out -> `session.current === null` and the payload disposes.

### Wave 2: server keyring delivery

- [ ] **2.1** Extend `SignedIn` in `@epicenter/svelte/auth` with `fetch: AuthFetch` (additive; existing openers ignore it).
- [ ] **2.2** Add the keyring endpoint in `packages/server` (e.g. `GET /api/keyring`): authenticate the owner (ADR-0067), `parseRootKeyring(env.ENCRYPTION_SECRETS)`, `deriveKeyring({ rootKeyring, label: ownerId })`, respond `{ keyring }`. Wire it into both deployables (`apps/api` hosted and the self-host star).
- [ ] **2.3** In Whispering's `build`, fetch the keyring via `signedIn.fetch` and populate `SecretSession.keyring` (reactive); handle the pending and error states.
- [ ] **2.4** Prove: a signed-in session reaches `session.current.keyring` non-null on hosted and on a self-host star with its own `ENCRYPTION_SECRETS`. Keyring fetch failure leaves the session usable with `keyring: null` (vault stays passthrough; facade falls back to device-local).

### Out of scope (next wave: "Wire the vault to the session")

Attaching the `epicenter:secret-vault` doc, `createEncryptedYkvLww` + `activateEncryption`, the first-sign-in device-to-vault migration, facade routing, the per-secret sync badges and provenance UI, and pointing Vocab at the same facade. This spec ends at the seam.

## Edge Cases

### Signed-out (the safe degenerate)
1. No session is constructed past `signed-out` status; `session.current === null`.
2. The vault facade reads `deviceConfig` exactly as today.
3. Outcome: zero behavior change, no gate, no broken flow.

### reauth-required
1. OAuth token expires; auth publishes `reauth-required` (keeps `ownerId`).
2. `createSession` keeps the existing payload mounted (per its JSDoc: a signed-out gap precedes a different-owner mount, so two consecutive identity states are the same owner).
3. Outcome: the vault keeps working; a refresh re-attaches the bearer.

### Different-owner sign-in
1. Owner A signs out (payload disposes), owner B signs in.
2. `createSession` builds a fresh payload; `SecretSession` is owner-scoped via `ownerId`.
3. Outcome: B's keyring is fetched fresh; A's vault replica was disposed.

### Keyring endpoint unreachable / offline
1. `signedIn.fetch GET /api/keyring` fails.
2. `SecretSession.keyring` stays `null`; the session is otherwise usable.
3. Outcome: the (future) vault stays in passthrough and the facade falls back to device-local. No blank-key reaches a provider SDK (facade still returns `available | missing`).

### Self-host
1. Instance carries a `token`; `createAppAuthClient` returns a `createInstanceTokenAuth` client.
2. `/api/keyring` runs on the operator's own star with the operator's `ENCRYPTION_SECRETS`.
3. Outcome: the operator derives their own keyring; Epicenter is never in the loop (ADR-0075). `ownerId` resolves to the constant `INSTANCE_OWNER_ID` (ADR-0075's pin-to-constant rule), so the derived keyring is one shared vault for the instance, not per-person -- consistent with self-host having no per-user identity today.

## Open Questions

1. **Keyring endpoint shape: dedicated `/api/keyring` vs fold into `/api/session`.**
   - Options: (a) a dedicated `GET /api/keyring`; (b) extend the `/api/session` response with the keyring.
   - **Recommendation:** dedicated `/api/keyring`. ADR-0067 keeps `/api/session` as the auth identity reader; the keyring is a distinct, owner-scoped capability and may want its own cache/rotation semantics. Leave open.

2. **Where the keyring fetch lives: Whispering's `build` vs `createSession` itself.**
   - Context: putting it in `createSession` (so `SignedIn` carries `keyring`) would benefit every Shape A app, but forces a keyring fetch on apps that do not consume one yet.
   - **Recommendation:** keep it in Whispering's `build` for now (add only `fetch` to `SignedIn`). Promote keyring into `SignedIn` when a second app needs it. Minimal shape, named seam.

3. **Web grant storage: `sessionStorage` vs in-memory.**
   - Context: `sessionStorage` survives reloads within a tab but not a closed tab; in-memory requires re-sign-in on every load.
   - **Recommendation:** `sessionStorage` for tolerable repeat sign-in with a smaller blast radius than `localStorage`. Revisit if the vault surface is judged account-critical.

4. **OAuth callback transport on Tauri.**
   - Context: deep-link vs loopback `localhost` callback for the desktop PKCE flow.
   - **Recommendation:** match whatever the extension/CLI launcher pattern already standardizes; verify against `createOAuthAppAuth` before building 1.1.

## Success Criteria

- [ ] Signed-out Whispering is unchanged: device-local secrets, no gate, no regression (verified against current behavior).
- [ ] Signing in on web (`whispering.epicenter.so`) and on Tauri both reach `session.current.ownerId`, using the same `createAppAuthClient`.
- [ ] The web grant is stored in `sessionStorage`/memory, not `localStorage`; the Tauri grant is in the keychain.
- [ ] `GET /api/keyring` returns a per-owner `Keyring` for the authenticated owner on hosted and on a self-host star; the client never receives `rootKeyring`.
- [ ] `session.current.keyring` is non-null after a successful fetch and `null` (session still usable) on failure.
- [ ] Sign-out disposes the payload (`session.current === null`).
- [ ] Typecheck and the auth/encryption test suites pass.
- [ ] ADR-0079 flips from Proposed to Accepted when the work lands.

## References

- `apps/whispering/src/lib/state/secrets.svelte.ts` - the vault facade and its auth-seam JSDoc (the activation steps).
- `apps/whispering/src/lib/workspace/` and `src/lib/platform/` - Shape B layout and the `#platform/*` seam to mirror.
- `packages/svelte-utils/src/session.svelte.ts` - `createSession` and the `SignedIn` payload to extend.
- `packages/auth/src/app-auth-client.ts` - `createAppAuthClient` (the branch on instance token).
- `apps/tab-manager/src/lib/platform/auth/` - the Shape B + OAuth launcher precedent.
- `packages/encryption/src/derivation.ts` - `deriveKeyring({ rootKeyring, label })`.
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts` - `createEncryptedYkvLww` + `activateEncryption`.
- `docs/adr/0074-...md`, `docs/adr/0079-...md` - the vault and the transport decision.
