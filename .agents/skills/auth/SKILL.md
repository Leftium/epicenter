---
name: auth
description: Epicenter auth packages — @epicenter/auth (framework-agnostic core) and @epicenter/auth-svelte (Svelte 5 reactive wrapper). Covers SessionStore contract, session/token subscription fan-out, and how consumer apps wire login/logout into sync and encryption.
metadata:
  author: epicenter
  version: '1.0'
---

# Epicenter Auth

Two packages:

- **`@epicenter/auth`** — framework-agnostic. Owns the Better Auth transport, session-rotation interceptor, and imperative subscription fan-out. Pure TypeScript, no Svelte.
- **`@epicenter/auth-svelte`** — thin Svelte 5 wrapper. Subscribes once to the core's `on*` primitives and projects them onto `$state`-backed getters.

Everything runtime lives in the core. The Svelte package only adds reactive reads.

> **Related Skills**: `factory-function-composition` for the `SessionStore` structural-contract pattern. `error-handling` for the `AuthError` variants (`InvalidCredentials`, `SignInFailed`, `SignUpFailed`, `SocialSignInFailed`).

## When to Apply This Skill

Use this skill when:

- Wiring a new consumer app to `@epicenter/auth-svelte` (see any `apps/*/src/lib/client.svelte.ts` or `auth.ts`).
- Reacting to login/logout/token rotation in sync, encryption, or storage layers.
- Writing or reviewing a `SessionStore` adapter (chrome.storage, localStorage, a custom persisted state).
- Deciding between reactive reads (`auth.session`) and imperative reads (`auth.getSession()`).

## The Package Split

```
@epicenter/auth          @epicenter/auth-svelte
├── createAuth            ├── createAuth           (shadows, wraps core)
├── AuthCore (type)       ├── AuthClient (type)    (= AuthCore + reactive getters)
├── SessionStore (type)   └── re-exports the core's types
├── AuthSession, StoredUser
└── AuthError
```

Consumer apps import `createAuth` from **`@epicenter/auth-svelte`** — never from the core directly in Svelte apps. Non-Svelte contexts (CLI, workers, tests) import from `@epicenter/auth`.

## The SessionStore Contract

`createAuth` takes a `SessionStore`, not a storage backend. The store is where the persisted session lives — the core reads and writes it but never persists itself.

```ts
export type SessionStore = {
  get(): AuthSession | null;
  set(value: AuthSession | null): void;
  watch(fn: (next: AuthSession | null) => void): () => void;
};
```

**Invariants** (copy exactly when writing an adapter):

- All three methods are **synchronous**. Async backends (IndexedDB, chrome.storage) hydrate once at boot, cache in memory, and expose a sync read.
- `watch` fires for **every** state change, including local writes via `set()`. Stores whose native event only fires on external change must fan out local writes themselves.
- `set()` is fire-and-forget. It may persist asynchronously, but the next `get()` returns the new value immediately.

### Prefer using `createPersistedState` / `createStorageState` directly

Both factories in `@epicenter/svelte` and `apps/tab-manager/src/lib/state/storage-state.svelte.ts` are **structurally assignable** to `SessionStore`. Pass them directly:

```ts
// apps/dashboard/src/lib/auth.ts
export const auth = createAuth({
  baseURL: window.location.origin,
  session: createPersistedState({
    key: 'dashboard:authSession',
    schema: AuthSession.or('null'),
    defaultValue: null,
  }),
});
```

No adapter layer. The earlier `fromPersistedState` / `fromStorageState` adapters were folded into the factories — don't reintroduce them.

## Wiring a consumer app

The canonical shape (fuji, honeycrisp, opensidian, zhongwen all look like this):

```ts
import { AuthSession, createAuth } from '@epicenter/auth-svelte';
import { createPersistedState } from '@epicenter/svelte';

const session = createPersistedState({
  key: 'fuji:authSession',
  schema: AuthSession.or('null'),
  defaultValue: null,
});

export const auth = createAuth({
  baseURL: APP_URLS.API,
  session,
});
```

Validate the stored value with Arktype: `AuthSession.or('null')` — if storage ever holds a malformed session, the schema rejects it and the default (`null`) takes over.

## Reacting to session transitions

**One subscription drives everything.** In consumer apps (see `apps/fuji/src/lib/client.svelte.ts:64`), a single `auth.onSessionChange` call handles login, logout, and token rotation:

```ts
auth.onSessionChange((next, previous) => {
  if (next === null) {
    sync.goOffline();
    sync.setToken(null);
    if (previous !== null) void idb.clearLocal();  // logout, not cold-boot
    return;
  }
  encryption.applyKeys(next.encryptionKeys);
  sync.setToken(next.token);
  sync.reconnect();
});
```

**Transition matrix:**

| `previous` | `next` | Meaning                 |
| ---------- | ------ | ----------------------- |
| `null`     | `null` | Anonymous replay (subscribe before hydration) — safe no-op |
| `null`     | session | Login, OR cold-boot of a returning authenticated user |
| session    | session (different token) | Token rotation |
| session    | `null` | Logout — wipe local data |

Use the `previous` argument to distinguish cold-boot from logout. Don't clear local data on every `null` branch.

**Cold-boot note.** A subscriber attached *before* the store hydrates receives two calls: the initial replay with `(null, null)`, then the hydrated value via `watch` as `(session, null)`. A subscriber attached *after* hydration receives one call: `(session, null)` on replay. Both shapes look like login to handlers that key on `previous === null && next !== null` — which is the correct behavior (encryption keys and sync tokens must be re-applied on every cold boot), but it means `onLogin` fires on every page load for returning users, not only on fresh sign-in.

## Session store write ownership

Two code paths write to the session store, partitioned by **field**:

| Writer | Fields owned | When |
| ------ | ------------ | ---- |
| `onSuccess` fetch interceptor | `token` only | Token rotation via `set-auth-token` response header. Writes `{ ...current, token: rotatedToken }`. |
| `useSession.subscribe` | `user`, `encryptionKeys` (always); `token` (initial only) | Session establishment, profile updates, encryption key rotation, account switch. |
| `useSession.subscribe` | `null` | Sign-out, server-side revocation. |

**Token strategy:** `current?.token ?? state.data.session.token` — if we already have a session, preserve our token (onSuccess may have rotated it and BA's async refetch can emit a stale pre-rotation value). On initial establishment (current is null), use BA's token.

**Why field-level, not null-partition.** An earlier design gated `useSession` data writes on `current === null`. This blocked encryption key rotation, account switching without sign-out, and user profile updates — all cases where `useSession` legitimately carries new data while a session already exists. The field-level partition solves the token race without blocking those flows.

**Cross-tab sign-in/out** is handled by the persisted store's platform events (`StorageEvent` for `createPersistedState`, `chrome.storage.onChanged` for `createStorageState`), not by `useSession.subscribe`. Both stores propagate external writes to all `watch` subscribers automatically.

## Firing order on any session transition

1. `session.set(next)` is called; `getSession()` now returns `next`.
2. The store's `watch` callback runs and notifies the core.
3. `onSessionChange` subscribers fire with `(next, previous)`.
4. `onLogin` fires if the transition was `null → session`.
5. `onLogout` fires if the transition was `session → null`.
6. `onTokenChange` fires if `previous?.token !== next?.token`.

Every subscriber runs in its own try/catch — one throwing does not prevent others from firing.

## Subscription primitives

| Method | Fires on | Replays on subscribe? |
| ------ | -------- | --------------------- |
| `onSessionChange(fn)` | Any session transition | Yes — with `(current, null)` |
| `onTokenChange(fn)` | Token changes (including rotation) | Yes — with current token |
| `onLogin(fn)` | `null → session` | Only if a session already exists |
| `onLogout(fn)` | `session → null` | No |
| `onBusyChange(fn)` | In-flight op counter flips 0↔non-0 | Yes — with current busy state |

`isBusy` is a counter, not a boolean — overlapping ops don't flip busy false prematurely.

## Reactive vs imperative reads

`AuthClient` (from `@epicenter/auth-svelte`) exposes both:

```ts
// Reactive — use in templates, $derived, $effect
auth.session       // AuthSession | null
auth.token         // string | null
auth.user          // StoredUser | null
auth.isAuthenticated  // boolean
auth.isBusy        // boolean

// Imperative — use in fetch interceptors, one-shot callbacks, non-reactive contexts
auth.getSession()
auth.getToken()
auth.getUser()
auth.onSessionChange((next, previous) => { ... })
```

**Rule**: subscribe imperatively at setup time (one `onSessionChange` in the client builder). Read reactively in components. Don't mix — don't subscribe inside `$effect` when the reactive getter already exists.

## Social sign-in

`signInWithSocialRedirect` works anywhere (web default). `signInWithSocialPopup` requires a `socialTokenProvider` — native apps and extensions inject one at `createAuth` time. Web apps that only use redirect sign-in omit it entirely. If popup is called without a provider, it returns `AuthError.SocialSignInFailed`.

## Common Pitfalls

- **Subscribing inside an `$effect`** — the reactive getter already tracks. Subscribe once at setup, read reactively in components.
- **Reading `{current}` on `auth`** — `auth` isn't a runed box. Read the reactive getters directly (`auth.session`, not `auth.session.current`).
- **Clearing local data on cold-boot** — guard logout handlers with `if (previous !== null)`, or `null → null` at boot will wipe an anonymous user's in-progress state.
- **Importing `createAuth` from `@epicenter/auth` in Svelte apps** — always use `@epicenter/auth-svelte` for the reactive wrapper. The core import is for framework-agnostic consumers (CLI, workers).
- **Writing an adapter where none is needed** — if your store already exposes `{ get, set, watch }`, pass it directly; don't wrap it.
- **Wrapping `signInWithSocialRedirect` in `runBusy`** — the page navigates away on success. `isBusy` is never read, and the promise never resolves on the happy path. The other auth ops (`signIn`, `signUp`, `signOut`, `signInWithSocialPopup`) genuinely use `runBusy` because the user waits for a result.
- **Passing `baseURL` as a function** — `createAuthClient` only accepts a string. The value is read once at construction. If the origin can change at runtime (e.g. tab-manager's `remoteServerUrl`), the consumer must recreate the auth client — a lazy thunk cannot be honored.
- **Adding a second data writer to the session store** — see "Session store write ownership" above. The partition on `current === null` eliminates the token rotation race. Adding another path that writes session data when `current !== null` reintroduces the race with `onSuccess`.
