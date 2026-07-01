import {
	type AuthClient,
	type CreateAppAuthClientOptions,
	type CreateSameOriginCookieAuthConfig,
	createAppAuthClient as createCoreAppAuthClient,
	createSameOriginCookieAuth as createCoreSameOriginCookieAuth,
	type Instance,
	type SyncAuthClient,
} from '@epicenter/auth';
import { createSubscriber } from 'svelte/reactivity';

// `createSession`/`SignedIn` bind a `SyncAuthClient` (produced by the reactive
// `createAppAuthClient` below) to a workspace lifecycle, so the whole reactive
// auth + session story is one subpath. Re-exported here rather than from the
// package root, which stays pure workspace-data reactivity (`fromTable`, etc.).
export { createSession, type SignedIn } from './session.svelte.js';

/**
 * Make an auth client's `state` Svelte-reactive: spread the closure-bound
 * client and override `state` with a getter that calls `subscribe()` so reads
 * inside `$derived` / `$effect` track changes. Generic over the client type so
 * a `SyncAuthClient` stays a `SyncAuthClient` (the same transform applies to
 * either credential model; only the underlying client differs). The cast is
 * needed because a spread over a generic loses the precise type even though the
 * shape is preserved.
 */
function reactiveAuthClient<T extends AuthClient>(auth: T): T {
	const subscribeState = createSubscriber((update) => auth.onStateChange(update));
	const reactive = {
		...auth,
		get state() {
			subscribeState();
			return auth.state;
		},
	} as T;
	// The self-host token client also exposes a connection-verification channel
	// (pending / unreachable / rejected) that changes without touching `state`, so
	// give it its own subscriber. Clients without one (hosted OAuth, cookie) skip
	// this and keep the plain spread value (undefined).
	const source = auth.connection;
	if (source) {
		const subscribeConnection = createSubscriber((update) =>
			source.onChange(update),
		);
		reactive.connection = {
			get state() {
				subscribeConnection();
				return source.state;
			},
			onChange: source.onChange,
		};
	}
	return reactive;
}

/**
 * Svelte 5 wrapper around `createAppAuthClient`: the one client-side choke point
 * that turns a persisted `Instance` into a hosted-OAuth or self-host-token
 * client (the branch is internal). Returns a Svelte-reactive `SyncAuthClient`,
 * so it can be passed to `createSession` for cloud sync.
 */
export function createAppAuthClient(
	instance: Instance,
	options: CreateAppAuthClientOptions,
): SyncAuthClient {
	return reactiveAuthClient(createCoreAppAuthClient(instance, options));
}

/**
 * Svelte 5 wrapper around `createSameOriginCookieAuth` (cookie client for a
 * browser app the API serves from its own origin, e.g. the dashboard). Returns
 * a plain `AuthClient` (no `openWebSocket`); it cannot be passed to
 * `createSession`.
 */
export function createSameOriginCookieAuth(
	config: CreateSameOriginCookieAuthConfig,
): AuthClient {
	return reactiveAuthClient(createCoreSameOriginCookieAuth(config));
}
