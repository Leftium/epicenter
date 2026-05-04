import {
	type AuthClient as BaseAuthClient,
	type CreateAuthConfig,
	createAuth as createCoreAuth,
} from '@epicenter/auth';

export type AuthClient = BaseAuthClient;

/**
 * Svelte 5 wrapper around `@epicenter/auth`.
 *
 * Mirrors the core identity into `$state` so templates and derived values can
 * read `auth.identity` reactively. The spread copies core methods, and the
 * later getter overrides the copied identity value.
 */
export function createAuth(config: CreateAuthConfig): AuthClient {
	const base = createCoreAuth(config);
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
