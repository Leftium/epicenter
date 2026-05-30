import {
	type AuthClient,
	type CreateOAuthAppAuthConfig,
	type CreateSameOriginCookieAuthConfig,
	createOAuthAppAuth as createCoreOAuthAppAuth,
	createSameOriginCookieAuth as createCoreSameOriginCookieAuth,
} from '@epicenter/auth';
import { createSubscriber } from 'svelte/reactivity';

/**
 * Make an `AuthClient`'s `state` Svelte-reactive: spread the closure-bound
 * client and override `state` with a getter that calls `subscribe()` so reads
 * inside `$derived` / `$effect` track changes. The same transform applies to
 * either credential model; only the underlying client differs.
 */
function reactiveAuthClient(auth: AuthClient): AuthClient {
	const subscribe = createSubscriber((update) => auth.onStateChange(update));
	return {
		...auth,
		get state() {
			subscribe();
			return auth.state;
		},
	};
}

/**
 * Svelte 5 wrapper around `createOAuthAppAuth` (PKCE/bearer client for
 * cross-origin and native runtimes).
 */
export function createOAuthAppAuth(
	config: CreateOAuthAppAuthConfig,
): AuthClient {
	return reactiveAuthClient(createCoreOAuthAppAuth(config));
}

/**
 * Svelte 5 wrapper around `createSameOriginCookieAuth` (cookie client for a
 * browser app the API serves from its own origin, e.g. the dashboard).
 */
export function createSameOriginCookieAuth(
	config: CreateSameOriginCookieAuthConfig,
): AuthClient {
	return reactiveAuthClient(createCoreSameOriginCookieAuth(config));
}
