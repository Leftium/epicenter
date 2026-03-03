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

- [x] **2.1** `packages/server-remote/src/auth/plugin.ts` — Extended `AuthPluginConfig` with `emailAndPassword` and `socialProviders`. Added `seedAdminIfNeeded()`. Made `createAuthPlugin` accept a pre-created auth instance to enable sharing.
- [x] **2.2** `packages/server-remote/src/remote.ts` — Auto-wires `{ verify }` from Better Auth session when `config.auth` is set but `sync.auth` is not. Shares a single auth instance between the auth plugin and sync verify.

### Wave 3: Client-side sync simplification

- [ ] **3.1** `packages/sync/src/types.ts` — Remove `token?: string` from `SyncProviderConfig`. Keep `getToken`.
- [ ] **3.2** `packages/sync/src/provider.ts` — Remove the `staticToken` code path (lines ~419-421). Remove `cachedToken = staticToken ?? null`.
