import {
	type AuthClient as BaseAuthClient,
	type CreateAuthConfig,
	createAuth as createBaseAuthClient,
} from '@epicenter/auth';

export type AuthClient = BaseAuthClient;

/**
 * Svelte 5 wrapper around `@epicenter/auth`.
 *
 * Mirrors the core snapshot into `$state` so templates and derived values can
 * read `auth.snapshot` reactively. The spread copies core methods, and the
 * later getter overrides the copied snapshot value.
 */
export function createAuth(config: CreateAuthConfig): AuthClient {
	const base = createBaseAuthClient(config);
	let snapshot = $state(base.snapshot);

	const unsubscribe = base.onSnapshotChange((next) => {
		snapshot = next;
	});

	return {
		...base,
		get snapshot() {
			return snapshot;
		},
		[Symbol.dispose]() {
			unsubscribe();
			base[Symbol.dispose]();
		},
	} satisfies AuthClient;
}
