# Two-Mode Auth with Centralized OAuth

**Status**: In Progress
**Branch**: braden-w/rm-token-auth

## Summary

Remove the token auth mode from sync auth, simplifying from three modes (open/token/verify) to two modes (open/verify). The `{ token: string }` variant was a shared-secret approach being replaced by Better Auth's session-based verify mode.

## Implementation Plan

### Wave 1: Server-side auth (packages/server/)

- [x] **1.1** `packages/server/src/sync/auth.ts` — Removed `{ token: string }` from `AuthConfig` union. Removed `'token' in config` branch. AuthConfig is now `{ verify: fn }`.
- [x] **1.2** `packages/server/src/sync/auth.test.ts` — Removed `describe('token mode', ...)` suite. Updated edge cases to use `{ verify: ... }`.
- [x] **1.3** `packages/server/src/sync/plugin.test.ts` — Replaced all `{ token: 'secret' }` with `{ verify: (t) => t === 'secret' }`.
- [x] **1.4** `packages/server/src/index.ts` — No change needed (no `tokenAuth` export exists).
- [x] **1.5** `packages/server/src/sync/index.ts` — No change needed (no `tokenAuth` export exists).

### Wave 2: Server-remote auth enhancements

- [ ] **2.1** `packages/server-remote/src/auth/plugin.ts` — Extend `AuthPluginConfig` with `emailAndPassword?: { enabled?: boolean; disableSignUp?: boolean }` and `socialProviders?: Record<string, { clientId: string; clientSecret: string }>`. Pass through to `betterAuth()`. Add `seedAdminIfNeeded()`.
- [ ] **2.2** `packages/server-remote/src/remote.ts` — When `config.auth` is provided but `config.sync?.auth` is not, auto-create a `{ verify: async (token) => ... }` that calls `auth.api.getSession()`.

### Wave 3: Client-side sync simplification

- [ ] **3.1** `packages/sync/src/types.ts` — Remove `token?: string` from `SyncProviderConfig`. Keep `getToken`.
- [ ] **3.2** `packages/sync/src/provider.ts` — Remove the `staticToken` code path (lines ~419-421). Remove `cachedToken = staticToken ?? null`.
