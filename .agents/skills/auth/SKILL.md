---
name: auth
description: Epicenter auth packages, @epicenter/auth and @epicenter/auth-svelte. Covers SessionStorage, auth snapshots, sync authentication, and app wiring.
metadata:
  author: epicenter
  version: '2.0'
---

# Epicenter Auth

Three packages:

- **`@epicenter/auth`**: framework-agnostic core. Owns Better Auth transport, boot-cache storage hydration, response-header token rotation, and snapshot change fan-out.
- **`@epicenter/auth-svelte`**: Svelte 5 wrapper. Mirrors the core snapshot into `$state` and exposes a live `auth.snapshot` getter.
- **`@epicenter/auth-workspace`**: framework-agnostic binding from auth snapshots to workspace lifecycle effects.

Everything runtime lives in the core. The Svelte package only makes the snapshot reactive.

## When to Apply This Skill

Use this skill when:

- Wiring a consumer app to `@epicenter/auth-svelte`.
- Reacting to auth transitions in sync, encryption, or storage layers.
- Writing or reviewing a `SessionStorage` adapter.
- Reading auth state in UI, fetch callbacks, or workspace sync callbacks.

## Public Surface

Auth has one public read path and one readiness promise:

```ts
type AuthSnapshot =
	| { status: 'loading' }
	| { status: 'signedOut' }
	| { status: 'signedIn'; session: Session };
```

Read `auth.snapshot` synchronously. Await `auth.whenLoaded` only at async boundaries that must wait for persisted storage hydration, such as `auth.fetch` and authenticated sync setup.

Use `auth.onSnapshotChange(fn)` for future changes only. It does not replay. Consumers that need bootstrap behavior must read `auth.snapshot` once and then register the listener.

Do not add projection helpers. There is no public token, user, session, authenticated, or busy getter beyond `auth.snapshot`.

## SessionStorage Contract

`createAuth` takes a `SessionStorage`. The storage object is a boot cache for the last known local session; auth owns the in-memory snapshot and Better Auth owns live session state.

```ts
export type MaybePromise<T> = T | Promise<T>;

export type SessionStorage = {
	load(): MaybePromise<Session | null>;
	save(value: Session | null): MaybePromise<void>;
};
```

Invariants:

- `load()` returns the persisted session or `null`.
- Sync stores can leave `loading` before `createAuth()` returns.
- Async stores start in `loading` and transition after `load()` settles.
- `whenLoaded` never rejects. Load failures are logged and normalize to `signedOut`.
- Local writes update the snapshot first, then call `save()`.
- Live auth changes flow through Better Auth session emissions, `auth.snapshot`, and `auth.onSnapshotChange()`.

## Wiring a Consumer App

```ts
import {
	createAuth,
	createSessionStorageAdapter,
	Session,
} from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';

const sessionStorage = createPersistedState({
	key: 'fuji:authSession',
	schema: Session.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	sessionStorage: createSessionStorageAdapter(sessionStorage),
});
```

Tab-manager wraps the `createStorageState()` result the same way. Do not await `sessionStorage.whenReady` before constructing auth. Auth owns the load barrier.

## Reacting to Session Transitions

Use `bindAuthWorkspaceScope` at setup time for browser app clients:

```ts
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';

bindAuthWorkspaceScope({
	auth,
	syncControl: workspace.sync,
	applyAuthSession(session) {
		workspace.encryption.applyKeys(session.encryptionKeys);
	},
	async resetLocalClient() {
		try {
			await workspace.idb.clearLocal();
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

`attachSync` owns the token read. It waits for `auth.whenLoaded`, reads `auth.snapshot`, and reconnects when `auth.onSnapshotChange()` reports a token change. Do not add `getToken`, `tokenSource`, `onTokenChange`, or a token projection helper to auth.

`auth.fetch` follows the same snapshot rule internally: wait for hydration, read the current signed-in token, then send the request.

## Write Ownership

Keep field ownership narrow:

| Writer | Fields owned |
| --- | --- |
| Persisted load | Initial whole session |
| Response header rotation | `session.token` only |
| Better Auth session refetch | `user`, `encryptionKeys`, and initial token |

Persisted storage owns the first transition out of `loading`. The Better Auth session subscription opens only after the boot cache settles; nanostore's atom replays the current value to the late subscriber, so a Better Auth state present at construction time is reconciled into the cache-derived snapshot.

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
{:else if snapshot.status === 'signedOut'}
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

- In the Svelte wrapper, spread the core auth object only before overriding `snapshot`. Object spread invokes the base getter and copies the current value, so `get snapshot()` must appear after `...base`.
- Do not destructure `auth.snapshot` at module scope. That freezes the current value.
- Do not clear local data on cold boot. Clear only when the previous snapshot was `signedIn` and the next snapshot is `signedOut`.
- Do not import `createAuth` from `@epicenter/auth` in Svelte apps. Use `@epicenter/auth-svelte`.
- Do not wrap redirect sign-in in global auth busy state. The page navigates away on success; local state is enough for commands that stay on the page.
