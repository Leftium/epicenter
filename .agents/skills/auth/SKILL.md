---
name: auth
description: Epicenter auth packages, @epicenter/auth and @epicenter/auth-svelte. Covers initial session wiring, two-state auth snapshots, sync authentication, and app lifecycle binding.
metadata:
  author: epicenter
  version: '3.0'
---

# Epicenter Auth

Three packages own the auth surface:

- **`@epicenter/auth`**: framework-agnostic core. Owns Better Auth transport, response-header token rotation, save callbacks, and snapshot change fan-out.
- **`@epicenter/auth-svelte`**: Svelte 5 wrapper. Mirrors the core snapshot into `$state` and exposes a live `auth.snapshot` getter.
- **`@epicenter/auth-workspace`**: framework-agnostic binding from auth snapshots to workspace lifecycle effects.

The core factory is synchronous. Callers load persisted state first, then pass the loaded value into `createAuth`.

## When to Apply This Skill

Use this skill when:

- Wiring a consumer app to `@epicenter/auth-svelte`.
- Reacting to auth transitions in sync, encryption, or storage layers.
- Loading a persisted session before constructing auth.
- Reading auth state in UI, fetch callbacks, or workspace sync callbacks.

## Public Surface

Auth has one public read path:

```ts
type AuthSnapshot =
	| { status: 'signedOut' }
	| { status: 'signedIn'; session: AuthSession };
```

Read `auth.snapshot` synchronously. Auth has no readiness promise. If a caller has async storage, it must await that storage before constructing auth.

Use `auth.onSnapshotChange(fn)` for future changes only. It does not replay. Consumers that need bootstrap behavior must read `auth.snapshot` once and then register the listener.

Do not add projection helpers. There is no public token, user, session, authenticated, or busy getter beyond `auth.snapshot`.

## createAuth Contract

`createAuth` takes the already-loaded session and a save callback:

```ts
export type CreateAuthConfig = {
	baseURL: string;
	initialSession: AuthSession | null;
	saveSession(value: AuthSession | null): void | Promise<void>;
};
```

Invariants:

- `initialSession` is the first snapshot. `null` means `signedOut`.
- `createAuth()` returns with a definite `signedIn` or `signedOut` snapshot.
- Local writes update the in-memory snapshot first, then call `saveSession()`.
- Save failures are logged and do not roll back the in-memory snapshot.
- Live auth changes flow through Better Auth session emissions, `auth.snapshot`, and `auth.onSnapshotChange()`.
- Dispose is idempotent so HMR can safely call it more than once.

## Wiring a Browser App

For synchronous persisted state, read the value directly:

```ts
import { AuthSession, createAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';

const session = createPersistedState({
	key: 'fuji:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	initialSession: session.get(),
	saveSession: (next) => session.set(next),
});
```

For async storage, await the storage boundary before constructing auth:

```ts
await session.whenReady;

export const auth = createAuth({
	baseURL: APP_URLS.API,
	initialSession: session.get(),
	saveSession: (next) => session.set(next),
});
```

## Reacting to Session Transitions

Use `bindAuthWorkspaceScope` at setup time for browser app clients:

```ts
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';

bindAuthWorkspaceScope({
	auth,
	syncControl: workspace.syncControl,
	applyAuthSession(session) {
		workspace.encryption.applyKeys(session.encryptionKeys);
	},
	async resetLocalClient() {
		try {
			await workspace.clearLocalData();
			window.location.reload();
		} catch (error) {
			reportCleanupError(error);
		}
	},
});
```

The app owns concrete resource composition. Pass `syncControl: null` when there is no authenticated sync attachment. For root plus child documents, pass a small inline object whose `pause()` and `reconnect()` methods call every active sync surface. Keep destructive reset policy inside `resetLocalClient()`.

## Sync Authentication

Workspace sync takes the auth client directly:

```ts
const sync = attachSync(ydoc, {
	url: toWsUrl(`${APP_URLS.API}/workspaces/${ydoc.guid}`),
	waitFor: idb,
	auth,
	awareness,
});
```

`attachSync` reads the current token from `auth.snapshot` and reconnects when `auth.onSnapshotChange()` reports a token change. Do not add `getToken`, `tokenSource`, `onTokenChange`, or a token projection helper to auth.

`auth.fetch` follows the same snapshot rule internally: read the current signed-in token, then send the request.

## Write Ownership

Keep field ownership narrow:

| Writer | Fields owned |
| --- | --- |
| Caller load | Initial whole session |
| Response header rotation | `session.token` only |
| Better Auth session refetch | `user`, `encryptionKeys`, and initial token |

Preserve a rotated token across Better Auth refetch:

```ts
session: {
	token: current?.token ?? state.data.session.token,
	user: normalizeUser(state.data.user),
	encryptionKeys: state.data.encryptionKeys,
}
```

## Svelte UI Reads

Read `auth.snapshot` in templates, `$derived`, or `$effect`:

```svelte
<script lang="ts">
	const snapshot = $derived(auth.snapshot);
</script>

{#if snapshot.status === 'signedIn'}
	<p>{snapshot.session.user.name}</p>
{:else}
	<AuthForm {auth} />
{/if}
```

In-flight command state belongs to the issuing component:

```svelte
<script lang="ts">
	let busy = $state(false);

	async function submit() {
		busy = true;
		try {
			await auth.signIn({ email, password });
		} finally {
			busy = false;
		}
	}
</script>
```

## Common Pitfalls

- In the Svelte wrapper, spread the core auth object before overriding `snapshot`. Object spread invokes the base getter and copies the current value, so `get snapshot()` must appear after `...base`.
- Do not destructure `auth.snapshot` at module scope. That freezes the current value.
- Do not clear local data on cold boot. Clear only when the previous snapshot was `signedIn` and the next snapshot is `signedOut`.
- Do not import `createAuth` from `@epicenter/auth` in Svelte apps. Use `@epicenter/auth-svelte`.
- Do not wrap redirect sign-in in global auth busy state. The page navigates away on success; local state is enough for commands that stay on the page.
