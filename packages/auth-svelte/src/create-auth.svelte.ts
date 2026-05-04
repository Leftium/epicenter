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
 * read `auth.snapshot` reactively. The returned object lists each core method
 * explicitly because spreading a getter would copy only the initial snapshot.
 */
export function createAuth(config: CreateAuthConfig): AuthClient {
	const base = createBaseAuthClient(config);
	let snapshot = $state(base.snapshot);

	const unsubscribe = base.onSnapshotChange((next) => {
		snapshot = next;
	});

	return {
		get snapshot() {
			return snapshot;
		},
		get whenLoaded() {
			return base.whenLoaded;
		},
		onSnapshotChange: base.onSnapshotChange,
		signIn: base.signIn,
		signUp: base.signUp,
		signInWithSocialPopup: base.signInWithSocialPopup,
		signInWithSocialRedirect: base.signInWithSocialRedirect,
		signOut: base.signOut,
		fetch: base.fetch,
		[Symbol.dispose]() {
			unsubscribe();
			base[Symbol.dispose]();
		},
	};
}
