import {
	type AuthClient as BaseAuthClient,
	type CreateBearerAuthConfig,
	type CreateBrowserAuthConfig,
	createBearerAuth as createCoreBearerAuth,
	createBrowserAuth as createCoreBrowserAuth,
} from '@epicenter/auth';

export type AuthClient = BaseAuthClient;

/**
 * Svelte 5 wrapper around `@epicenter/auth`.
 *
 * Mirrors the core identity into `$state` so templates and derived values can
 * read `auth.identity` reactively. The spread copies core methods, and the
 * later getter overrides the copied identity value.
 */
function createReactiveAuth(base: BaseAuthClient): AuthClient {
	let identity = $state(base.identity);

	const unsubscribe = base.onChange((next) => {
		identity = next;
	});

	return {
		...base,
		get identity() {
			return identity;
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

export function createBrowserAuth(config: CreateBrowserAuthConfig): AuthClient {
	return createReactiveAuth(createCoreBrowserAuth(config));
}
