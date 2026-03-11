# Tab Manager Auth Gate Overhaul

**Date**: 2026-03-11
**Status**: In Progress
**Author**: AI-assisted

## Overview

Remove the authentication gate that blocks the entire tab manager UI, making the app fully functional without sign-in. Auth becomes an opt-in feature for cloud sync and AI chat. Additionally, fix the Better Auth account linking bug that prevents users from signing in with Google when they already have an email/password account with the same email.

## Motivation

### Current State

The `AuthGate` component wraps the entire app in `App.svelte`:

```svelte
<!-- apps/tab-manager/src/entrypoints/sidepanel/App.svelte -->
<AuthGate>
  <Tooltip.Provider>
    <main>
      <header><!-- search, commands, AI, sync indicator --></header>
      <UnifiedTabList />
    </main>
  </Tooltip.Provider>
</AuthGate>
```

`AuthGate` has three states:
1. **`checking`**—spinner, entire app invisible
2. **`signed-out`/`signing-in`**—full-screen login form, entire app invisible
3. **`signed-in`**—app renders, sign-out button in footer

This creates problems:

1. **App is unusable without authentication.** The tab manager's core features—viewing tabs, saving tabs, bookmarks, grouping, search, command palette—are all local operations that use Chrome APIs and IndexedDB. None require a server. But the auth gate blocks all of them.

2. **Auth framing is wrong.** The login screen says "Sign in to sync your tabs across devices." But the app presents it as a hard requirement, not an opt-in feature. Users who just want local tab management are forced through auth.

3. **Account linking is broken.** When a user signs up with email/password and later tries "Continue with Google" using the same email, Better Auth returns a `LINKING_NOT_ALLOWED` error (HTTP 401) because the server has no `accountLinking` configuration. The user sees a generic "Google sign-in failed" error with no guidance.

4. **Sync status indicator lacks auth context.** The cloud icon shows "Offline—click to reconnect" when unauthenticated, but reconnecting with no token just fails again silently.

### Desired State

- App opens instantly, all local features available without sign-in
- Cloud sync icon is the entry point for authentication
- Clicking the cloud icon when signed out opens a sign-in popover
- When signed in, cloud icon shows connection status + account info
- Google and email/password accounts with the same email auto-link seamlessly
- AI chat shows "Sign in to use AI" prompt when unauthenticated

## Research Findings

### What Features Actually Need Auth?

| Feature | Auth Required? | Dependency |
|---|---|---|
| View/manage open tabs | No | Chrome `tabs` API |
| Save/restore tabs | No | Y.Doc + IndexedDB (local) |
| Bookmarks | No | Y.Doc + IndexedDB (local) |
| Tab groups, pin, mute, reload | No | Chrome `tabs`/`tabGroups` API |
| Cross-tab sync (same browser) | No | BroadcastChannel |
| Search tabs | No | Local state |
| Command palette | No | Local |
| **Cross-device sync** | **Yes** | WebSocket → server (`authGuard` on `/workspaces/*`) |
| **AI chat** | **Yes** | Server route `/ai/*` behind `authGuard` |

The workspace client already initializes local-first:

```typescript
// apps/tab-manager/src/lib/workspace.ts
export const workspaceClient = createWorkspace(defineWorkspace({ ... }))
  .withExtension('persistence', indexeddbPersistence)    // ← loads from IndexedDB
  .withExtension('broadcast', broadcastChannelSync)      // ← cross-tab sync
  .withExtension('sync', createSyncExtension({           // ← remote sync (needs auth)
    url: (workspaceId) => `${serverUrl.current}/workspaces/${workspaceId}`,
    getToken: async () => authState.token ?? '',
  }));
```

IndexedDB and BroadcastChannel work without auth. The sync extension already handles missing/empty tokens gracefully—it enters `connecting` phase, gets a 401 from the server, and reports `lastError.type === 'auth'`.

### Better Auth Account Linking

**Source**: Better Auth docs (`better-auth.com/docs/concepts/users-accounts`), Better Auth GitHub (`better-auth/better-auth`)

#### The Problem

The server config in `packages/server-remote/src/app.ts` has **no `accountLinking` configuration**:

```typescript
// packages/server-remote/src/app.ts — current config
export const BASE_AUTH_CONFIG = {
  basePath: '/auth',
  emailAndPassword: { enabled: true },
} as const;

function createAuth(db: Db, env: Env['Bindings']) {
  return betterAuth({
    ...BASE_AUTH_CONFIG,
    socialProviders: {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    },
    // ❌ No account.accountLinking — this is why the error occurs
  });
}
```

#### How Better Auth Handles It

When `signIn.social` is called with an `idToken` (our browser extension flow), Better Auth's `handleOAuthUserInfo()` function:

1. Extracts user info (email, name) from the Google `idToken`
2. Looks up existing user by email
3. Finds the email/password user but **no linked Google account**
4. Checks `accountLinking` config:
   - If `accountLinking.enabled` is `false` (default) → returns error
   - If provider is not in `trustedProviders` AND email isn't verified by provider → returns error
5. Returns `LINKING_NOT_ALLOWED` error with HTTP 401

For the `idToken` flow specifically, the error comes back as an `APIError` object (not a redirect), with:
- **Code**: `LINKING_NOT_ALLOWED` or `OAUTH_LINK_ERROR`
- **Message**: `"Account not linked - linking not allowed"`
- **HTTP Status**: 401 Unauthorized

#### The Fix

Better Auth provides `account.accountLinking` configuration:

```typescript
account: {
  accountLinking: {
    enabled: true,
    trustedProviders: ["google", "email-password"],
  }
}
```

**What `trustedProviders` does**: When a provider is listed as trusted, Better Auth auto-links accounts even if the provider doesn't confirm email verification status. This is safe for Google because Google verifies emails before issuing `idTokens`.

**Including `"email-password"`**: Allows the reverse flow too—if a user signs up with Google first, then later tries email/password with the same email, it links automatically.

**Security note from Better Auth docs**: "When a provider is listed as trusted, Better Auth will automatically link accounts even if the provider does not confirm the email verification status. This can increase the risk of account takeover if an attacker can create an account with a victim's email address on a trusted provider that doesn't verify email ownership." Google verifies email ownership, so this is safe. We would NOT add untrusted providers here.

#### Additional Options (Not Required, For Reference)

```typescript
account: {
  accountLinking: {
    enabled: true,
    trustedProviders: ["google", "email-password"],
    allowDifferentEmails: false,        // default — don't link mismatched emails
    updateUserInfoOnLink: false,        // default — don't overwrite user name/image
    disableImplicitLinking: false,      // default — allow auto-linking during sign-in
  }
}
```

### SyncStatusIndicator Auth Awareness

The sync extension already reports auth failures:

```typescript
// packages/sync-client/src/types.ts
type SyncStatus =
  | { phase: 'offline' }
  | { phase: 'connecting'; attempt: number; lastError?: SyncError }
  | { phase: 'connected' };

type SyncError =
  | { type: 'auth'; error: unknown }    // ← token fetch failed
  | { type: 'connection' };
```

And the `SyncStatusIndicator` already checks for auth errors:

```typescript
// apps/tab-manager/src/lib/components/SyncStatusIndicator.svelte
if (s.lastError?.type === 'auth')
  return 'Authentication failed—click to reconnect';
```

But "click to reconnect" doesn't help—the user needs to **sign in**, not reconnect. The indicator needs to become the auth entry point.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Remove AuthGate wrapper | Remove from App.svelte | All core features are local-first; auth gate serves no purpose for local tab management |
| Auth entry point | SyncStatusIndicator popover | Natural location—cloud sync is what auth enables. Already has the icon + tooltip. |
| Auth form location | Popover from cloud icon | Side panel is narrow; a full-page form wastes space once app works without auth. Popover keeps context visible. |
| Account linking | `trustedProviders: ["google", "email-password"]` | Google verifies emails, so auto-linking is safe. Covers both directions (email→Google, Google→email). |
| AI chat when unauthenticated | Show inline prompt | Better than hiding the button—user discovers the feature exists but needs auth. |
| Sign-out location | Inside sync popover account section | Grouped with auth-related actions, not a permanent footer. |
| Keep AuthGate component | Repurpose as auth form content | The login form UI is fine; it just shouldn't wrap the whole app. Extract form into reusable component. |

## Architecture

### Before (Current)

```
┌──────────────────────────────────────────┐
│ App.svelte                               │
│  └─ AuthGate (BLOCKS EVERYTHING)         │
│      ├─ checking → spinner               │
│      ├─ signed-out → login form          │
│      └─ signed-in → actual app           │
│          ├─ Header (search, sync, AI)    │
│          └─ UnifiedTabList               │
└──────────────────────────────────────────┘
```

### After (Proposed)

```
┌──────────────────────────────────────────────┐
│ App.svelte (always renders)                  │
│  ├─ Header                                   │
│  │   ├─ Search                               │
│  │   ├─ Commands button                      │
│  │   ├─ AI Chat button                       │
│  │   └─ SyncStatusIndicator                  │
│  │       └─ Popover (on click)               │
│  │           ├─ signed-out → AuthForm        │
│  │           │   ├─ Google OAuth button       │
│  │           │   ├─ Email/password form       │
│  │           │   └─ Sign up / Sign in toggle  │
│  │           └─ signed-in → AccountPanel     │
│  │               ├─ User info (name, email)   │
│  │               ├─ Sync status details       │
│  │               └─ Sign out button           │
│  └─ UnifiedTabList (always visible)          │
└──────────────────────────────────────────────┘
```

### Auth State Flow

```
APP LOAD
────────
1. IndexedDB loads Y.Doc (local data available immediately)
2. BroadcastChannel connects (cross-tab sync)
3. Auth checks cached token in chrome.storage.local
4. Sync extension attempts WebSocket connection
   ├─ Has valid token → connects → cross-device sync active
   ├─ Has expired token → 4xx → clears token → offline
   ├─ No token → empty string → 401 → offline (expected)
   └─ Server unreachable → trusts cached user → offline

UI always renders. Sync status indicator shows connection state.
User can sign in anytime via cloud icon popover.
```

## Implementation Plan

### Phase 1: Remove Auth Gate (Core Change)

- [x] **1.1** Extract the login form from `AuthGate.svelte` into a new `AuthForm.svelte` component (reusable form content without the gate wrapper logic)
- [x] **1.2** Remove `<AuthGate>` wrapper from `App.svelte`—app renders unconditionally
- [x] **1.3** Update `authState.checkSession()` to handle the "no token" case without showing a loading spinner—if no token in storage, immediately set `signed-out` status (it already does this, but verify the `checking` state doesn't flash)
  > **Note**: Moved the `onMount` + `$effect` from AuthGate directly into App.svelte. The `checking` state never flashes because `checkSession()` fast-paths to `signed-out` when no token exists (no server round-trip).
- [x] **1.4** Verify that `workspaceClient` initializes correctly without auth (IndexedDB + BroadcastChannel should work; sync extension should enter `connecting` → `offline` gracefully)
  > **Note**: Verified by code inspection—`workspaceClient` uses `authState.token ?? ''` for the token, sync extension handles empty tokens gracefully (gets 401, enters offline).

### Phase 2: SyncStatusIndicator as Auth Entry Point

- [x] **2.1** Add a `Popover` to `SyncStatusIndicator` that opens on click
- [x] **2.2** When `authState.status === 'signed-out'`, popover shows `AuthForm`
- [x] **2.3** When `authState.status === 'signed-in'`, popover shows account panel (user name, email, sync status, sign-out button)
- [x] **2.4** After successful sign-in from popover, call `reconnectSync()` (already happens in current AuthGate form handlers)
  > **Note**: AuthForm calls `reconnectSync()` internally on successful sign-in/sign-up/Google OAuth.
- [x] **2.5** Update tooltip text: "Sign in to sync across devices" when signed out; keep existing tooltips for other states
- [x] **2.6** Add visual indicator to the cloud icon when signed out (e.g., a small dot or different icon variant) so users know sync is available but inactive
  > **Note**: Added a small primary-colored dot indicator on the cloud icon when signed out. Also uses muted-foreground color for CloudOff when unauthenticated (vs destructive when authenticated but disconnected).

### Phase 3: Fix Account Linking (Server Change)

- [x] **3.1** Add `account.accountLinking` config to `BASE_AUTH_CONFIG` in `packages/server-remote/src/app.ts`:
  ```typescript
  export const BASE_AUTH_CONFIG = {
    basePath: '/auth',
    emailAndPassword: { enabled: true },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google", "email-password"],
      },
    },
  } as const;
  ```
- [x] **3.2** Verify the same config is picked up by `better-auth.config.ts` (it spreads `BASE_AUTH_CONFIG`)
- [ ] **3.3** Test: sign up with email → sign in with Google (same email) → should auto-link
- [ ] **3.4** Test: sign up with Google → sign in with email (same email) → should auto-link

### Phase 4: AI Chat Auth Prompt

- [ ] **4.1** In `AiDrawer.svelte`, check `authState.status` before rendering chat
- [ ] **4.2** When signed out, show a prompt: "Sign in to use AI chat" with a button that opens the sync popover or triggers auth directly
- [ ] **4.3** When signed in, render chat normally (no change to existing behavior)

## Edge Cases

### User opens app for the first time (no cached auth)

1. `authToken` in chrome.storage.local is `undefined`
2. `authState.checkSession()` sees no token → sets `signed-out` immediately (no server round-trip)
3. App renders with local data (empty saved tabs, empty bookmarks, live tabs from Chrome API)
4. Sync indicator shows "offline" state with tooltip "Sign in to sync across devices"
5. User can use all local features immediately

### User was previously signed in, token expired

1. `authToken` has a value in storage
2. `authState.checkSession()` sends it to server
3. Server returns 4xx → `clearState()` → `signed-out`
4. App still renders (was already rendered while checking)
5. Sync extension disconnects, status changes to `offline`
6. User sees cloud icon change; can re-authenticate via popover

### User signs in with Google, email conflicts with existing account (current bug)

1. User clicks "Continue with Google" in the auth popover
2. Google returns `idToken` with email `user@gmail.com`
3. Better Auth's `handleOAuthUserInfo()` finds existing email/password user
4. **With Phase 3 fix**: Google is in `trustedProviders` → auto-links → sign-in succeeds
5. **Without fix**: Returns `LINKING_NOT_ALLOWED` (401) → user sees error in popover

### Browser goes offline while app is open

1. Sync extension detects connection drop (heartbeat timeout, 5 seconds max)
2. Status changes to `connecting` with backoff
3. Local operations continue unaffected (Y.Doc + IndexedDB)
4. When online again, sync reconnects automatically
5. No auth state change—cached user is trusted when server is unreachable

### Multiple browser contexts (tabs, windows)

1. Auth token stored in `chrome.storage.local` (shared across extension contexts)
2. `authState.reactToTokenCleared()` watches for external token changes via `$effect`
3. Signing out in one context clears token → other contexts detect via storage change → set `signed-out`
4. BroadcastChannel sync keeps Y.Doc consistent across contexts regardless of auth state

## Open Questions

1. **Popover vs Sheet for auth form in side panel?**
   - Side panel width is ~300-400px. A popover might be too cramped for the full form.
   - Options: (a) Popover with compact form, (b) Sheet sliding from bottom, (c) Dialog overlay
   - **Recommendation**: Start with a Popover (simplest). If it feels cramped during implementation, switch to a Sheet. The auth form content (`AuthForm.svelte`) is the same either way.

2. **Should the "checking" state still show a spinner anywhere?**
   - Currently, AuthGate shows a full-screen spinner during `checking`. With the gate removed, the app renders immediately.
   - The `checking` state is brief (reads from chrome.storage.local, then optionally validates with server).
   - **Recommendation**: No spinner. The sync indicator can show `connecting` state (spinning loader icon) while auth is being checked. The app is functional regardless.

3. **Should we show a first-run onboarding hint?**
   - New users might not discover the cloud icon is the sign-in entry point.
   - Options: (a) No hint—icon tooltip is sufficient, (b) One-time tooltip/callout pointing to cloud icon, (c) Banner at top
   - **Recommendation**: Defer. The tooltip "Sign in to sync across devices" on the cloud icon is discoverable enough. Add onboarding later if analytics show poor discovery.

4. **Should `authState.checkSession()` run on app load when there's no token?**
   - Currently it runs on mount in AuthGate, which will still exist... but AuthGate is being removed.
   - The check needs to happen somewhere on app load to validate cached sessions.
   - **Recommendation**: Move the `onMount` + `$effect` from AuthGate into `App.svelte` or into the `authState` module itself (self-initializing).

## Success Criteria

- [ ] App renders and is fully functional immediately on open without any authentication
- [ ] All local features work: tab list, save/restore, bookmarks, search, commands, groups, pin, mute
- [ ] SyncStatusIndicator opens a popover with sign-in form when clicked while signed out
- [ ] After sign-in via popover, sync connects and cross-device sync works
- [ ] Signing in with Google when an email/password account exists with the same email succeeds (auto-links)
- [ ] Signing in with email/password when a Google account exists with the same email succeeds (auto-links)
- [ ] AI chat shows appropriate "sign in" prompt when not authenticated
- [ ] Sign-out is accessible from the sync popover's account panel
- [ ] No regressions in cross-device sync for already-authenticated users

## References

- `apps/tab-manager/src/entrypoints/sidepanel/App.svelte` — Main app component, currently wraps everything in AuthGate
- `apps/tab-manager/src/lib/components/AuthGate.svelte` — Current auth gate component (to be decomposed)
- `apps/tab-manager/src/lib/components/SyncStatusIndicator.svelte` — Sync status icon (to become auth entry point)
- `apps/tab-manager/src/lib/state/auth.svelte.ts` — Auth state singleton
- `apps/tab-manager/src/lib/workspace.ts` — Workspace client with sync extension
- `packages/server-remote/src/app.ts` — Better Auth server config (needs `accountLinking`)
- `packages/server-remote/better-auth.config.ts` — CLI config (spreads `BASE_AUTH_CONFIG`)
- `packages/sync-client/src/types.ts` — SyncStatus type definition
- `packages/workspace/src/extensions/sync.ts` — Sync extension factory
- Better Auth docs: [Users & Accounts](https://www.better-auth.com/docs/concepts/users-accounts) — Account linking configuration
- Better Auth docs: [OAuth](https://www.better-auth.com/docs/concepts/oauth) — Social sign-in and idToken flow
- Better Auth docs: [Google provider](https://www.better-auth.com/docs/authentication/google) — Google OAuth setup
- Better Auth docs: [Error reference](https://www.better-auth.com/docs/reference/errors) — `LINKING_NOT_ALLOWED` error
