# Auth Surface Simplification

**Date**: 2026-03-25
**Status**: Implemented
**Author**: Codex
**Branch**: `feat/sync-auto-reconnect`

## Overview

Simplify `packages/svelte-utils/src/auth-state.svelte.ts` so the public API matches the real product shape: normal browser SPAs are the default path, encrypted workspace apps are the second default path, and the Chrome extension is the one injected/custom path. Remove the current framework-ish layering, especially `createAuthController`, and replace it with constructors whose names and call sites match how apps actually use auth in this repo.

## Motivation

### Current State

The current auth module is already better than the original callback soup, but it still exposes too much internal architecture at the public boundary.

Current call sites:

```typescript
// apps/zhongwen/src/lib/auth.ts
const authApi = createWebAuthApi({
	baseURL: APP_URLS.API,
});

const sessionStore = createLocalSessionStore('zhongwen');

export const authState = createSessionAuthState({
	authApi,
	sessionStore,
});
```

```typescript
// apps/honeycrisp/src/lib/auth/index.ts
const authApi = createWebAuthApi({
	baseURL: APP_URLS.API,
});

const sessionStore = createLocalSessionStore('honeycrisp');

export const authState = createWorkspaceAuthState({
	authApi,
	sessionStore,
	workspace,
});
```

```typescript
// apps/tab-manager/src/lib/state/auth.svelte.ts
const authApi = createAuthApi({
	baseURL: () => remoteServerUrl.current,
	signInWithGoogle: async (client) => {
		// extension-specific OAuth flow
	},
});

const sessionStore = createReactiveSessionStore({
	token: authToken,
	user: authUser,
	ready: Promise.all([authToken.whenReady, authUser.whenReady]),
});

export const authState = createWorkspaceAuthState({
	authApi,
	sessionStore,
	workspace,
	restoreUserKey: async () => {
		const cached = await keyCache.load();
		return cached ? base64ToBytes(cached) : null;
	},
});
```

The shared file still has these public concepts:

- `createWebAuthApi()`
- `createAuthApi()`
- `createLocalSessionStore()`
- `createReactiveSessionStore()`
- `createSessionAuthState()`
- `createWorkspaceAuthState()`

And internally the real engine is still a generic helper:

```typescript
function createAuthController(
	{ authApi, sessionStore }: SessionAuthStateConfig,
	lifecycle: InternalLifecycle,
) {
	// almost all logic lives here
}
```

This creates a few problems:

1. **The public API still reflects implementation layering instead of product usage**: most apps do not think in terms of `authApi + sessionStore + auth state constructor`; they just want "create auth for this app."
2. **`createAuthController` is a smell**: it owns nearly all behavior, while the public constructors are thin wrappers around it. That usually means the code is organized around an internal engine rather than real domain concepts.
3. **The common SPA path is still too verbose**: the web apps all spell out the same setup in three steps even though their implementation is nearly identical.
4. **The extension is the real outlier, but the API treats every environment as equally abstract**: that is backwards. The default case should be tiny; the odd case can be more explicit.
5. **Some shapes are still awkward**: `AuthSession = { session, encryptionKey }` adds a nested `session.session.user` shape, and `authApi` is a reasonable name but still more architectural than product-facing.

### Desired State

The public API should make the default case obvious:

```typescript
// generic SPA auth
export const auth = createAuth({
	baseURL: APP_URLS.API,
	storageKey: 'zhongwen',
});
```

```typescript
// encrypted workspace SPA auth
export const auth = createWorkspaceAuth({
	baseURL: APP_URLS.API,
	storageKey: 'honeycrisp',
	workspace,
});
```

The extension should be the explicit injected path:

```typescript
export const auth = createWorkspaceAuthWith({
	client: createCustomAuthClient({
		baseURL: () => remoteServerUrl.current,
		signInWithGoogle: async (client) => {
			// extension-specific OAuth flow
		},
	}),
	store: createCustomAuthStore({
		token: authToken,
		user: authUser,
		ready: Promise.all([authToken.whenReady, authUser.whenReady]),
	}),
	workspace,
	restoreUserKey: async () => {
		const cached = await keyCache.load();
		return cached ? base64ToBytes(cached) : null;
	},
});
```

The default constructors should own the boring setup. The injected constructors should exist for the extension and any future outlier, but should not dominate the public surface.

## Research Findings

### Almost all real consumers are SPAs

Current in-repo consumers:

| App | Needs workspace decryption? | Storage style | Auth-init style |
| --- | --- | --- | --- |
| `apps/zhongwen` | No | localStorage | normal SPA / web redirect |
| `apps/honeycrisp` | Yes | localStorage | normal SPA / web redirect |
| `apps/opensidian` | Yes | localStorage | normal SPA / web redirect |
| `apps/tab-manager` | Yes | `chrome.storage` wrappers | extension-specific OAuth |

**Key finding**: three of the four real consumers follow the same normal browser pattern.

**Implication**: the public API should optimize for the SPA path and make the extension the explicit custom path.

### Workspace auth is a real domain concept

The workspace client already documents and implements sign-out as a destructive teardown:

- `deactivateEncryption()` clears keys
- deactivates encrypted stores
- wipes persisted data via `clearDataCallbacks`
- runs workspace cleanup hooks

This means "workspace auth" is not just auth plus a callback; it is a real product-level lifecycle.

**Key finding**: `createWorkspaceAuth` is a defensible public concept.

**Implication**: keep a distinct workspace-aware constructor instead of hiding workspace decryption behind generic lifecycle hooks.

### `createAuthController` is the real engine, which is a warning sign

The current shared file exposes multiple constructors, but the real logic lives in one private function:

```typescript
function createAuthController(...) {
	// signIn
	// signUp
	// signInWithGoogle
	// signOut
	// checkSession
	// fetch
	// store sync
	// lifecycle hooks
}
```

**Key finding**: the internal abstraction is doing more conceptual work than the public constructors.

**Implication**: either rename that internal concept to a real domain term or, preferably, eliminate it and let the public constructors read like the actual product concepts.

### The remaining DI seams are small and concrete

Even after simplification, two seams remain useful:

| Seam | Why it exists | Default case | Extension case |
| --- | --- | --- | --- |
| auth client | Web redirect vs extension OAuth popup | Better Auth redirect client | Better Auth client + custom Google flow |
| auth store | localStorage vs `chrome.storage` wrappers | simple storage key | reactive cell adapter with subscribe |

**Key finding**: dependency injection is still useful, but only for these two seams.

**Implication**: expose tiny default constructors for SPAs and narrow injected constructors for outliers.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Default generic auth name | `createAuth` | Short, obvious, and appropriate when browser SPA is the default environment |
| Default workspace auth name | `createWorkspaceAuth` | Keeps the meaningful domain distinction that signed-in implies decrypted workspace access |
| Escape hatch names | `createAuthWith` and `createWorkspaceAuthWith` | Makes the injected/custom path explicit without vague names like `custom` or clunky names like `web` |
| Internal Better Auth helper name | `createBetterAuthClient` or `createDefaultAuthClient` | "client" is more concrete than `authApi`; this helper is implementation detail, not the public mental model |
| Internal store helper names | `createLocalAuthStore` and `createCellAuthStore` | Narrow, concrete, and closer to what they actually do |
| Central internal helper | Remove `createAuthController` | Inline logic into public constructors or extract only small focused helpers |
| Auth result shape | Flatten to `{ user, token, encryptionKey? }` | Avoid nested `session.session.user` shape |
| Default SPA configuration | `baseURL` + `storageKey` | That is all the normal apps actually need |
| Extension configuration | `client` + `store` injected through `*With` constructors | Keeps the odd path explicit and contained |

## Proposed API

### Public API

```typescript
type CreateAuthOptions = {
	baseURL: string | (() => string);
	storageKey: string;
};

export function createAuth(options: CreateAuthOptions) { ... }

export function createWorkspaceAuth(
	options: CreateAuthOptions & {
		workspace: WorkspaceHandle;
	},
) { ... }

export function createAuthWith({
	client,
	store,
}: {
	client: AuthClient;
	store: AuthStore;
}) { ... }

export function createWorkspaceAuthWith({
	client,
	store,
	workspace,
	restoreUserKey,
}: {
	client: AuthClient;
	store: AuthStore;
	workspace: WorkspaceHandle;
	restoreUserKey?: () => Promise<Uint8Array | null>;
}) { ... }
```

### Internal API

```typescript
type AuthClient = {
	signIn(credentials: EmailSignInCredentials): Promise<AuthResult>;
	signUp(credentials: EmailSignUpCredentials): Promise<AuthResult>;
	signInWithGoogle(): Promise<AuthResult>;
	signOut(token: string | null): Promise<void>;
	getSession(token: string | null): Promise<AuthResult | null>;
};

type AuthStore = {
	ready: Promise<void>;
	read(): SessionSnapshot;
	write(snapshot: SessionSnapshot): void | Promise<void>;
	clear(): void | Promise<void>;
	subscribe?(listener: (snapshot: SessionSnapshot) => void): () => void;
};

type AuthResult = {
	user: StoredUser;
	token: string | null;
	encryptionKey?: string | null;
};
```

## Architecture

The target architecture should read like this:

```text
Default path
────────────
createAuth
  ├── createBetterAuthClient(baseURL)
  ├── createLocalAuthStore(storageKey)
  └── returns auth state

createWorkspaceAuth
  ├── createBetterAuthClient(baseURL)
  ├── createLocalAuthStore(storageKey)
  ├── workspace dependency
  └── returns workspace-aware auth state


Injected path
─────────────
createAuthWith
  ├── injected client
  ├── injected store
  └── returns auth state

createWorkspaceAuthWith
  ├── injected client
  ├── injected store
  ├── workspace dependency
  ├── optional restoreUserKey
  └── returns workspace-aware auth state
```

And the internal flow should be much flatter than today:

```text
signIn / signUp / signInWithGoogle
  -> call client method
  -> write store
  -> activate workspace if needed
  -> clear error / update status

signOut
  -> call client.signOut
  -> clear store
  -> deactivate workspace if needed

checkSession
  -> await store.ready
  -> restore cached user key if workspace variant
  -> call client.getSession
  -> on valid session: write store + activate workspace if needed
  -> on auth rejection: clear store + deactivate workspace
  -> on network/server failure: keep cached state
```

## File-Level Plan

### Primary file to refactor

- `packages/svelte-utils/src/auth-state.svelte.ts`

### App call sites to migrate

- `apps/zhongwen/src/lib/auth.ts`
- `apps/honeycrisp/src/lib/auth/index.ts`
- `apps/opensidian/src/lib/auth/index.ts`
- `apps/tab-manager/src/lib/state/auth.svelte.ts`

### Reference files to preserve behavior

- `apps/tab-manager/src/lib/state/storage-state.svelte.ts`
- `apps/tab-manager/src/lib/workspace/client.svelte.ts`
- `packages/workspace/src/workspace/create-workspace.ts`
- `packages/workspace/src/workspace/types.ts`

## Implementation Plan

### Phase 1: Rename and flatten the internal model

- [x] **1.1** Replace `AuthSession = { session, encryptionKey }` with a flat `AuthResult` shape.
- [x] **1.2** Replace `authApi` naming in internal types/helpers with `client` or `authClient`.
- [x] **1.3** Remove `createAuthController` and inline its behavior into the real constructors, extracting only small helper functions where necessary.
- [x] **1.4** Keep or improve the current JSDoc while flattening the architecture. Public constructors should explain when to use them, not just what they return.

### Phase 2: Create the default SPA constructors

- [x] **2.1** Add `createAuth({ baseURL, storageKey })`.
- [x] **2.2** Add `createWorkspaceAuth({ baseURL, storageKey, workspace })`.
- [x] **2.3** Move the localStorage + Better Auth web redirect defaults inside those constructors.
- [x] **2.4** Ensure the default SPA call sites become one small constructor call each.

### Phase 3: Create the injected constructors

- [x] **3.1** Add `createAuthWith({ client, store })`.
- [x] **3.2** Add `createWorkspaceAuthWith({ client, store, workspace, restoreUserKey? })`.
- [x] **3.3** Keep the extension on the injected workspace path.
- [x] **3.4** Rename helper constructors to concrete names like `createLocalAuthStore` and `createCellAuthStore` if they remain exported.

### Phase 4: Migrate apps

- [x] **4.1** Migrate Zhongwen to `createAuth`.
- [x] **4.2** Migrate Honeycrisp and Opensidian to `createWorkspaceAuth`.
- [x] **4.3** Migrate tab-manager to `createWorkspaceAuthWith`.
- [x] **4.4** Delete or rename obsolete exports so the old names do not remain as parallel APIs.

### Phase 5: Verification and cleanup

- [x] **5.1** Run formatting on touched files.
- [x] **5.2** Run the narrowest useful type-check available and note any unrelated repo blockers.
- [x] **5.3** Update this spec with review notes describing any deviations.

## Edge Cases

### Web Google redirect

1. A SPA calls `signInWithGoogle()`.
2. Better Auth starts a redirect and the page leaves.
3. This must not be treated as an auth failure; the auth state should simply survive until `checkSession()` rehydrates on the next load.

### Extension popup-based Google auth

1. The extension opens a popup via `browser.identity.launchWebAuthFlow`.
2. The popup returns an `id_token`.
3. The injected client must exchange that token through Better Auth and return a normal `AuthResult`.

### Auth rejection while workspace is cached

1. The app has persisted auth state and, for the extension, a cached user key.
2. `checkSession()` gets a 4xx auth rejection.
3. The store must clear and the workspace must deactivate encryption so local decrypted state is wiped.

### Offline or 5xx session check

1. The app has cached auth state.
2. `getSession()` fails because the server is unreachable.
3. Cached auth state should remain, and workspace auth should preserve whatever decrypt state was successfully restored before the roundtrip.

## Open Questions

1. **Should `createAuthWith` / `createWorkspaceAuthWith` be public long-term or implementation-only?**
   - Options: (a) public official API, (b) public but undocumented escape hatch, (c) internal only with an extension-specific local helper
   - **Recommendation**: keep them public for now because the extension genuinely needs them, then reevaluate once the design settles.

2. **Should `createLocalAuthStore` and `createCellAuthStore` remain exported?**
   - Options: (a) export both, (b) export only the cell adapter, (c) hide both behind the higher-level constructors
   - **Recommendation**: default to keeping only the cell adapter exported if the default constructors fully absorb localStorage setup.

3. **Should the extension continue to build its client inline, or get a small local helper like `createExtensionAuthClient()`?**
   - **Recommendation**: probably add a small local helper inside `apps/tab-manager/src/lib/state/auth.svelte.ts` or nearby if the inline client setup starts to feel noisy.

## Success Criteria

- [x] Default SPA auth call sites become a single constructor call each.
- [x] Workspace SPA auth call sites become a single constructor call each.
- [x] The extension remains fully supported through an explicit injected path.
- [x] `createAuthController` no longer exists.
- [x] `AuthResult` is flat; there is no `session.session.user` nesting.
- [x] Public naming reflects product usage instead of implementation layers.
- [x] Public JSDoc explains when to use `createAuth`, `createWorkspaceAuth`, `createAuthWith`, and `createWorkspaceAuthWith`.
- [x] Formatting and the narrowest useful verification pass complete, with unrelated repo blockers documented if present.

## References

- `packages/svelte-utils/src/auth-state.svelte.ts`
- `apps/zhongwen/src/lib/auth.ts`
- `apps/honeycrisp/src/lib/auth/index.ts`
- `apps/opensidian/src/lib/auth/index.ts`
- `apps/tab-manager/src/lib/state/auth.svelte.ts`
- `apps/tab-manager/src/lib/state/storage-state.svelte.ts`
- `apps/tab-manager/src/lib/workspace/client.svelte.ts`
- `packages/workspace/src/workspace/create-workspace.ts`
- `packages/workspace/src/workspace/types.ts`
