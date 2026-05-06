import {
	type AuthClient as BaseAuthClient,
	type CreateBearerAuthConfig,
	type CreateCookieAuthConfig,
	createBearerAuth as createCoreBearerAuth,
	createCookieAuth as createCoreCookieAuth,
} from '@epicenter/auth';

export type AuthClient = BaseAuthClient;

/**
 * Svelte 5 wrapper around `@epicenter/auth`.
 *
 * Mirrors the core state into `$state` so templates and derived values can
 * read `auth.state` reactively. The spread copies core methods, and the later
 * getter overrides the copied state value.
 */
function createReactiveAuth(base: BaseAuthClient): AuthClient {
	let state = $state(base.state);

	const unsubscribe = base.onStateChange((next) => {
		state = next;
	});

	return {
		...base,
		get state() {
			return state;
		},
		[Symbol.dispose]() {
			unsubscribe();
			base[Symbol.dispose]();
		},
	} satisfies AuthClient;
}

export function createBearerAuth(config: CreateBearerAuthConfig): AuthClient {
	return createReactiveAuth(createCoreBearerAuth(config));
}

export function createCookieAuth(config: CreateCookieAuthConfig): AuthClient {
	return createReactiveAuth(createCoreCookieAuth(config));
}
