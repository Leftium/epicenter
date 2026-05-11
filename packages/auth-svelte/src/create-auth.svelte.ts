import {
	type AuthClient,
	type CreateBearerAuthConfig,
	type CreateCookieAuthConfig,
	createBearerAuth as createCoreBearerAuth,
	createCookieAuth as createCoreCookieAuth,
} from '@epicenter/auth';
import { createSubscriber } from 'svelte/reactivity';

export type { AuthClient };

/**
 * Svelte 5 wrapper around `@epicenter/auth`.
 *
 * Bridges the core state listener into Svelte reactivity while preserving
 * live core getters such as `bearerToken`.
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
		get bearerToken() {
			return auth.bearerToken;
		},
		onStateChange(fn) {
			return auth.onStateChange(fn);
		},
		signIn(input) {
			return auth.signIn(input);
		},
		signUp(input) {
			return auth.signUp(input);
		},
		signInWithSocial(input) {
			return auth.signInWithSocial(input);
		},
		signOut() {
			return auth.signOut();
		},
		fetch(input, init) {
			return auth.fetch(input, init);
		},
		[Symbol.dispose]() {
			auth[Symbol.dispose]();
		},
	} satisfies AuthClient;
}

export function createBearerAuth(config: CreateBearerAuthConfig): AuthClient {
	return withReactiveState(createCoreBearerAuth(config));
}

export function createCookieAuth(config: CreateCookieAuthConfig): AuthClient {
	return withReactiveState(createCoreCookieAuth(config));
}
