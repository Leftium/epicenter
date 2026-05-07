---
name: auth
description: Epicenter auth packages, @epicenter/auth and @epicenter/auth-svelte. Covers the two auth factories, shared AuthClient surface, identity state, sync authentication, and workspace lifecycle binding.
metadata:
  author: epicenter
  version: '4.0'
---

# Epicenter Auth

Three packages own the auth surface:

- **`@epicenter/auth`**: framework-agnostic core. Owns Better Auth transport, token rotation for bearer clients, cookie fetch policy for cookie clients, identity fan-out, `fetch`, and the live `bearerToken` getter.
- **`@epicenter/auth-svelte`**: Svelte 5 wrapper. Mirrors the core identity into `$state` and exposes a live `auth.identity` getter.
- **`@epicenter/auth-workspace`**: framework-agnostic binding from auth identity changes to workspace lifecycle effects.

The core model is two factories, one client interface:

```ts
const cookieAuth = createCookieAuth({ baseURL, initialIdentity, saveIdentity });
const bearerAuth = createBearerAuth({ baseURL, initialSession, saveSession });
```

Both return `AuthClient`. Consumers use the same methods after construction and must not branch on which factory produced the client.

This model is grounded in `specs/20260503T230000-auth-unified-client-two-factories.md`, especially the section "Why Better Auth Already Solves This". Better Auth already supplies stale-while-revalidate identity, bearer transport, token rotation, cookie transport, and the caller-resolved sync hydration pattern. Epicenter composes those primitives instead of adding a parallel auth state machine.

## When to Apply This Skill

Use this skill when:

- Wiring a browser app, extension, daemon, CLI, or Svelte component to auth.
- Reacting to auth transitions in sync, encryption, or storage layers.
- Loading a persisted bearer session before constructing auth.
- Reading auth state in UI, fetch callbacks, or workspace sync callbacks.

## Public Surface

Auth has one public read path:

```ts
type AuthIdentity = {
	user: AuthUser;
	encryptionKeys: EncryptionKeys;
};

type AuthClient = {
	readonly state: AuthState;
	readonly bearerToken: string | null;
	onStateChange(fn: (state: AuthState) => void): () => void;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
};
```

Read `auth.state` synchronously. Use `waitForAuthSettled(auth)` when bootstrap needs the first settled session event.

Use `auth.onStateChange(fn)` for future changes only. It does not replay. Consumers that need bootstrap behavior must read `auth.state` once and then register the listener.

Do not add projection helpers. `auth.bearerToken` is the only public token read path, and it returns `null` for cookie auth.

## Factory Choice

Use `createCookieAuth` when the browser can use the API cookie jar:

```ts
import { createCookieAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';

export const auth = createCookieAuth({
	baseURL: APP_URLS.API,
	initialIdentity: cachedIdentity.get(),
	saveIdentity: (next) => cachedIdentity.set(next),
});
```

Use `createBearerAuth` when the runtime owns a bearer token: standalone-domain SPA, browser extension, daemon, or CLI. The caller loads storage before construction:

```ts
import { BearerSession, createBearerAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';

const initialSession = BearerSession.or('null').assert(await storage.read());

export const auth = createBearerAuth({
	baseURL: APP_URLS.API,
	initialSession,
	saveSession: (next) => storage.write(next),
});
```

`BearerSession` is the storage validation schema. Its token is visible only at the construction boundary and inside storage adapters. Do not pass it upward into UI, sync, or workspace lifecycle code.

## Workspace Binding

Identity-bound resources are read lazily through callbacks: workspaces don't hold the keys, they read them out of `auth.state` at every encryption attach site. The session module owns the workspace lifecycle (`createSession` from `@epicenter/svelte`), and each per-app build closure passes `() => requireSignedIn(auth).encryptionKeys` straight through to the workspace.

```ts
import { requireSignedIn } from '@epicenter/auth-svelte';
import { createSession, type SignedInBase } from '@epicenter/svelte';

type FujiSignedIn = SignedInBase & { readonly fuji: Fuji };

export const session = createSession<FujiSignedIn>({
	auth,
	build: (identity) => {
		const userId = identity.user.id;
		const fuji = openFuji({
			userId,
			peer,
			bearerToken: () => auth.bearerToken,
			encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
		});
		return {
			userId,
			fuji,
			[Symbol.dispose]() { fuji[Symbol.dispose](); },
		};
	},
});
```

`createSession` reconciles `auth.state`: a sign-out disposes the workspace, a same-user identity update is a no-op (the lazy callback observes the change at the next read), and a different-user transition disposes the workspace and reloads. Each `attachSync` still receives `bearerToken: () => auth.bearerToken`. For destructive reset (wipe local data and reload), call `workspace.wipe()` and `location.reload()` inside the consumer that triggers it; there is no terminal callback on the session itself.

For apps that need a side effect on every applied identity (like re-registering a device row), `bindAuthWorkspaceScope` from `@epicenter/auth-workspace` still exists. Its `applyAuthIdentity` no longer applies keys; pass an empty body or a side-effect-only callback:

```ts
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';

bindAuthWorkspaceScope({
	auth,
	applyAuthIdentity() {
		// keys are read lazily through requireSignedIn(auth) at the workspace boundary
		void registerDevice();
	},
	onSignOut() { window.location.reload(); },
	onIdentityChanged() { window.location.reload(); },
});
```

## Sync Authentication

Workspace sync takes a live bearer-token reader:

```ts
const sync = attachSync(ydoc, {
	url: toWsUrl(`${APP_URLS.API}/workspaces/${ydoc.guid}`),
	waitFor: idb.whenLoaded,
	bearerToken: () => auth.bearerToken,
	awareness,
});
```

`createCookieAuth` always returns `null` from `bearerToken`; the browser cookie jar handles credentials. `createBearerAuth` returns the current bearer token when signed in and `null` when signed out. `attachSync` owns WebSocket construction and adds the bearer subprotocol when the callback returns a token.

`auth.fetch` follows the same transport rule internally:

- Cookie auth uses `credentials: 'include'` and removes `Authorization`.
- Bearer auth uses `credentials: 'omit'` and sets `Authorization` from the private in-memory session.

## Svelte UI Reads

Read `auth.identity` in templates, `$derived`, or `$effect`:

```svelte
<script lang="ts">
	const identity = $derived(auth.identity);
</script>

{#if identity}
	<p>{identity.user.name}</p>
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

- In the Svelte wrapper, spread the core auth object before overriding `identity`. Object spread invokes the base getter and copies the current value, so `get identity()` must appear after `...base`.
- Do not destructure `auth.identity` at module scope. That freezes the current value.
- Do not clear local data on cold boot. Clear only when the previous identity was non-null and the next identity is null.
- Do not import a generic `createAuth`. It no longer exists. Choose `createCookieAuth` or `createBearerAuth` at construction.
- Do not expose bearer tokens above storage adapters. UI, workspace binding, and sync consume `AuthClient` capabilities.
- Do not wrap redirect sign-in in global auth busy state. The page navigates away on success; local state is enough for commands that stay on the page.
