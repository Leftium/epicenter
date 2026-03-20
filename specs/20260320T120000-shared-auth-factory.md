# Shared Auth Factory for Honeycrisp, Opensidian, and Tab Manager

**Date**: 2026-03-20
**Status**: Draft
**Author**: AI-assisted

## Overview

A shared `createAuthState` factory that provides auth state management (session, tokens, sign-in/out) across all Epicenter client apps—web SPAs (honeycrisp, opensidian) and the Chrome extension (tab-manager). Platform differences (storage, OAuth flow) are injected via adapters, so the core auth logic is written once.

## Motivation

### Current State

Honeycrisp and opensidian have no auth. They use local-only IndexedDB persistence:

```typescript
// apps/honeycrisp/src/lib/workspace/client.ts
export default createWorkspace(honeycrisp).withExtension(
  'persistence',
  indexeddbPersistence,
);
```

Tab-manager has a full auth implementation in `auth.svelte.ts`, but it's coupled to Chrome extension APIs:

```typescript
// Token storage — chrome.storage via WXT
const authToken = createStorageState('local:authToken', { ... });

// Google OAuth — chrome.identity API
const responseUrl = await browser.identity.launchWebAuthFlow({ ... });

// Form state co-located with auth state
let email = $state('');
let password = $state('');
let name = $state('');
let mode = $state<AuthMode>('sign-in');
```

This creates problems:

1. **No code sharing**: Honeycrisp and opensidian can't reuse tab-manager's auth logic because it's hardcoded to `chrome.storage` and `browser.identity`
2. **Form state in auth state**: `email`, `password`, `name`, `mode` are UI concerns mixed into the session singleton. Actions like `signIn()` read from closure state instead of taking parameters
3. **No sync for web apps**: Honeycrisp and opensidian can't sync because there's no auth to provide tokens to the sync extension

### Desired State

A shared factory where platform-specific bits are injected:

```typescript
// apps/honeycrisp/src/lib/auth.svelte.ts
import { createAuthState } from '$lib/auth/create-auth-state.svelte';

export const authState = createAuthState({
  baseURL: 'https://api.epicenter.so',
  storage: localStorageAdapter(),       // localStorage for web
  onSignedIn: (key) => workspace.activateEncryption(key),
  onSignedOut: () => workspace.deactivateEncryption(),
});
```

```typescript
// apps/tab-manager/src/lib/state/auth.svelte.ts (migrated)
import { createAuthState } from '$lib/auth/create-auth-state.svelte';

export const authState = createAuthState({
  baseURL: remoteServerUrl.current,
  storage: chromeStorageAdapter(),      // chrome.storage for extension
  signInWithGoogle: chromeIdentityFlow, // extension-specific OAuth
  onSignedIn: (key) => workspace.activateEncryption(key),
  onSignedOut: () => workspace.deactivateEncryption(),
});
```

Same factory, same phase machine, same API surface. Different adapters.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Factory location | Per-app file (not shared package) | Each app has different workspace wiring. The factory itself is small (~150 lines). Copy-adapt is simpler than a shared package for now. Extract to `@epicenter/svelte` later if a third web app needs it. |
| Form state | Lives in `AuthForm.svelte`, not in auth state | Form fields are UI concerns. Auth actions take explicit parameters (`signIn({email, password})`). Decouples auth state from form rendering. |
| Storage adapter | Callback-based (`get`, `set`, `whenReady`) | Abstracts localStorage vs chrome.storage without leaking platform details into core logic. |
| Google OAuth | Optional callback (`signInWithGoogle`) | Web apps use Better Auth's built-in redirect flow (no custom code needed). Extension passes `chrome.identity` flow. Factory handles both. |
| Workspace integration | `onSignedIn` / `onSignedOut` callbacks | Each app wires its own workspace (encryption, sync reconnect). Factory doesn't know about workspace internals. |
| Sync extension | Added to workspace client, reads `authState.token` | The sync extension's `getToken` already supports `undefined` (open mode). When signed out, sync runs unauthenticated or stays offline. |
| AuthForm component | Per-app Svelte component using shadcn-svelte | Each app may style/position differently. Component owns form state, calls `authState.signIn({...})` with explicit args. |
| Tab-manager migration | Deferred (Phase 3) | Get honeycrisp + opensidian working first. Migrate tab-manager later as a refactor—no user-facing changes. |

## Architecture

### Storage Adapter Interface

```
┌─────────────────────────────────────────────────────┐
│  AuthStorageAdapter                                  │
│  ├── getToken(): string | undefined                  │
│  ├── setToken(token: string | undefined): Promise    │
│  ├── getUser(): AuthUser | undefined                 │
│  ├── setUser(user: AuthUser | undefined): Promise    │
│  ├── whenReady: Promise<void>                        │
│  └── watch?(cb): unsubscribe  (optional, extensions) │
└─────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌──────────────────┐      ┌──────────────────────────┐
│ localStorage     │      │ chrome.storage.local      │
│ (web apps)       │      │ (tab-manager extension)   │
│                  │      │                            │
│ createPersisted  │      │ createStorageState         │
│ State() wrapper  │      │ + cross-context watch      │
└──────────────────┘      └──────────────────────────┘
```

### Factory Dependency Injection

```
createAuthState({
  baseURL,             ← server URL (string or () => string)
  storage,             ← AuthStorageAdapter (platform-specific)
  signInWithGoogle?,   ← optional override for OAuth flow
  onSignedIn?,         ← callback: (encryptionKey?) => void
  onSignedOut?,        ← callback: () => void
})
  │
  ▼
┌────────────────────────────────────────────────────────────┐
│  Auth State (shared logic)                                  │
│                                                             │
│  Phase machine: checking → signed-in | signed-out           │
│  Better Auth client: signIn.email, signUp.email, etc.       │
│  Session validation: checkSession with 4xx/5xx handling     │
│  Token refresh: onSuccess header interception               │
│                                                             │
│  Public API:                                                │
│  ├── status: AuthPhase['status']                            │
│  ├── user: AuthUser | undefined                             │
│  ├── token: string | undefined                              │
│  ├── signIn({email, password}): Result                      │
│  ├── signUp({email, password, name}): Result                │
│  ├── signInWithGoogle(): Result                             │
│  ├── signOut(): Result                                      │
│  └── checkSession(): Result                                 │
└────────────────────────────────────────────────────────────┘
```

### Workspace Wiring (per-app)

```
STEP 1: Create workspace with sync extension
──────────────────────────────────────────────
createWorkspace(honeycrisp)
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({
    url: (id) => `https://api.epicenter.so/workspaces/${id}`,
    getToken: async () => authState.token,    ← reads from auth state
  }))

STEP 2: Auth state wired with workspace callbacks
──────────────────────────────────────────────────
createAuthState({
  ...
  onSignedIn: async (encryptionKey) => {
    if (encryptionKey) workspace.activateEncryption(key);
    workspace.extensions.sync.reconnect();    ← trigger sync after login
  },
  onSignedOut: async () => {
    workspace.deactivateEncryption();
    workspace.extensions.sync.reconnect();    ← reconnect without token
  },
})

STEP 3: UI shows auth form optionally
──────────────────────────────────────
App works fully offline (IndexedDB).
User clicks "Sign in" → AuthForm appears.
On success → sync activates, encryption activates.
No gates, no paywalls.
```

## Implementation Plan

### Phase 1: Shared Auth Factory + Honeycrisp Integration

- [ ] **1.1** Create `apps/honeycrisp/src/lib/auth/types.ts` — `AuthStorageAdapter` type, `AuthUser` schema, `AuthPhase` type, `AuthError` definitions
- [ ] **1.2** Create `apps/honeycrisp/src/lib/auth/local-storage-adapter.svelte.ts` — implements `AuthStorageAdapter` using `createPersistedState` from `@epicenter/svelte`
- [ ] **1.3** Create `apps/honeycrisp/src/lib/auth/create-auth-state.svelte.ts` — the factory: accepts config with adapters, returns auth state API. Phase machine, Better Auth client, session validation, token refresh—all the shared logic from tab-manager but with explicit parameters and injected storage
- [ ] **1.4** Create `apps/honeycrisp/src/lib/auth/index.ts` — instantiate `createAuthState` with honeycrisp-specific config (localStorage adapter, workspace callbacks)
- [ ] **1.5** Add `better-auth` dependency to honeycrisp `package.json`
- [ ] **1.6** Update honeycrisp workspace client (`workspace/client.ts`) to include sync extension with `getToken: async () => authState.token`
- [ ] **1.7** Create `apps/honeycrisp/src/lib/components/AuthForm.svelte` — login/signup form with local form state, calls `authState.signIn({email, password})` etc. Uses `@epicenter/ui` Field/Input/Button
- [ ] **1.8** Create `apps/honeycrisp/src/lib/components/AccountPopover.svelte` — cloud/sync status indicator with sign-in trigger and sign-out button (inspired by tab-manager's `SyncStatusIndicator`)
- [ ] **1.9** Wire `AccountPopover` into honeycrisp's layout or sidebar
- [ ] **1.10** Test: app works without signing in (local-only), sign in activates sync

### Phase 2: Opensidian Integration

- [ ] **2.1** Copy auth files from honeycrisp to opensidian (types, adapter, factory, index) — adjust workspace callbacks for opensidian's workspace instance
- [ ] **2.2** Add `better-auth`, `wellcrafted`, `@epicenter/svelte` dependencies to opensidian `package.json`
- [ ] **2.3** Update opensidian workspace (`workspace.ts`) to include sync extension
- [ ] **2.4** Create opensidian `AuthForm.svelte` and `AccountPopover.svelte`
- [ ] **2.5** Wire into opensidian's `AppShell` or toolbar
- [ ] **2.6** Test: same flow as honeycrisp

### Phase 3: Tab-Manager Migration (deferred)

- [ ] **3.1** Create `apps/tab-manager/src/lib/auth/chrome-storage-adapter.svelte.ts` — wraps existing `createStorageState` into `AuthStorageAdapter`
- [ ] **3.2** Create `apps/tab-manager/src/lib/auth/chrome-identity-google.ts` — extracts `signInWithGoogle` into a standalone function matching the adapter signature
- [ ] **3.3** Refactor `auth.svelte.ts` to use `createAuthState` with chrome-specific adapters
- [ ] **3.4** Update `AuthForm.svelte` to use local form state instead of `authState.email` etc.
- [ ] **3.5** Verify cross-context sync still works (popup ↔ sidebar)

## Edge Cases

### Circular Dependency: Auth ↔ Workspace

1. Workspace sync needs `authState.token` (via `getToken`)
2. Auth state needs workspace callbacks (`onSignedIn` → `workspace.activateEncryption`)
3. Both are singletons that reference each other

Solution: Lazy references. The sync extension's `getToken` is a function that reads `authState.token` at call time (not at construction). The auth factory's `onSignedIn`/`onSignedOut` are callbacks that reference the workspace at call time. No circular import—just two modules that reference each other's exports through closures.

### Sign Out While Syncing

1. User signs out while sync is active
2. `onSignedOut` deactivates encryption and calls `sync.reconnect()`
3. Sync reconnects without a token → runs in open mode or server rejects with auth error
4. Sync extension handles this gracefully (backs off on auth error)

### Network Offline During Sign-In

1. User tries to sign in, but the network is down
2. Better Auth client returns an error
3. Phase transitions to `signed-out` with error message
4. App continues working locally—no data loss

### Token Expiry Mid-Session

1. User is signed in, token expires
2. Sync extension's `getToken` returns the stale token
3. Server rejects with auth error → sync enters `connecting` phase with `lastError.type === 'auth'`
4. `checkSession()` on next visibility change refreshes the token
5. Sync reconnects with fresh token

## Open Questions

1. **Should the factory live in a shared package (`@epicenter/svelte`) or per-app?**
   - Options: (a) `@epicenter/svelte` shared package, (b) per-app with copy, (c) new `@epicenter/auth` package
   - **Recommendation**: Start per-app (b). The factory is ~150 lines and each app has slightly different workspace wiring. Extract to shared package once we have 3+ apps using it and the API has stabilized. Premature extraction creates coupling.

2. **Should web apps support Google OAuth at launch?**
   - Web apps can use Better Auth's built-in redirect flow for Google sign-in (no custom code needed). The factory's optional `signInWithGoogle` callback is for overrides (like chrome.identity).
   - **Recommendation**: Include Google sign-in in AuthForm from the start. Better Auth's `client.signIn.social({ provider: 'google' })` handles the redirect flow automatically for web apps. No adapter needed—just call it directly.

3. **Should sync run in open mode when signed out, or stay offline?**
   - Options: (a) sync connects without token (open mode—server decides), (b) sync stays offline until signed in
   - **Recommendation**: (b) Stay offline. These are personal data apps (notes, files). Open mode sync without auth would mean anyone with the URL could read/write. Only connect sync when authenticated.

4. **Encryption activation on sign-in—should it block the UI?**
   - `refreshEncryptionKey()` fetches the session to get the encryption key, then activates encryption. This is async.
   - **Recommendation**: Don't block. Activate encryption in the background after sign-in. The workspace already handles the transition gracefully—unencrypted local data stays readable, and encryption activates for future writes.

## Success Criteria

- [ ] Honeycrisp works fully offline without signing in (existing behavior preserved)
- [ ] Signing in to honeycrisp activates sync and encryption
- [ ] Signing out deactivates sync/encryption but preserves local data
- [ ] Opensidian has the same auth flow as honeycrisp
- [ ] Auth form uses local form state, not global singleton state
- [ ] `signIn`/`signUp` take explicit `{email, password}` parameters
- [ ] No `chrome.storage` or `browser.identity` references in web app code
- [ ] `lsp_diagnostics` clean on all changed files
- [ ] Both apps build successfully (`bun run build`)

## References

- `apps/tab-manager/src/lib/state/auth.svelte.ts` — existing auth implementation to adapt from
- `apps/tab-manager/src/lib/components/AuthForm.svelte` — existing auth UI
- `apps/tab-manager/src/lib/components/SyncStatusIndicator.svelte` — account popover pattern
- `apps/tab-manager/src/lib/workspace.ts` — sync extension + `getToken` wiring
- `packages/svelte-utils/src/createPersistedState.svelte.ts` — localStorage adapter for web
- `packages/workspace/src/extensions/sync.ts` — sync extension factory
- `packages/sync-client/src/provider.ts` — sync provider with token handling
- `apps/api/src/app.ts` — Better Auth server config + trusted origins
