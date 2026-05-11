import {
	type AuthClient,
	type CreateOAuthAppAuthConfig,
	createOAuthAppAuth as createCoreOAuthAppAuth,
} from '@epicenter/auth';
import { createSubscriber } from 'svelte/reactivity';

export type { AuthClient };

/**
 * Svelte 5 wrapper around `@epicenter/auth`.
 *
 * Bridges the core state listener into Svelte reactivity.
 */
function withReactiveState(auth: AuthClient): AuthClient {
	const subscribe = createSubscriber((update) => {
		return auth.onStateChange(update);
	});

	return {
		get state() {
			subscribe();
			return auth.state;
		},
		onStateChange(fn) {
			return auth.onStateChange(fn);
		},
		startSignIn(input) {
			return auth.startSignIn(input);
		},
		signOut() {
			return auth.signOut();
		},
		fetch(input, init) {
			return auth.fetch(input, init);
		},
		openWebSocket(url, protocols) {
			return auth.openWebSocket(url, protocols);
		},
		[Symbol.dispose]() {
			auth[Symbol.dispose]();
		},
	} satisfies AuthClient;
}

export function createOAuthAppAuth(
	config: CreateOAuthAppAuthConfig,
): AuthClient {
	return withReactiveState(createCoreOAuthAppAuth(config));
}
