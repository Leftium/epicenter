import {
	type AuthCore,
	createAuth as createAuthCore,
	type CreateAuthConfig,
} from '@epicenter/auth';
import type { AuthSession, StoredUser } from '@epicenter/auth';

/**
 * Reactive projection of `AuthCore`. Imperative `on*` subscriptions are
 * wrapped into Svelte 5 `$state`-backed getters so templates can read
 * `auth.session` / `auth.token` / `auth.isBusy` directly without manual
 * effect wiring. All imperative methods on the core pass through unchanged.
 */
export type AuthClient = Omit<AuthCore, 'isAuthenticated' | 'isBusy'> & {
	readonly token: string | null;
	readonly session: AuthSession | null;
	readonly user: StoredUser | null;
	readonly isAuthenticated: boolean;
	readonly isBusy: boolean;
};

/**
 * Svelte 5 wrapper around `@epicenter/auth`'s `createAuth`.
 *
 * Subscribes once to the core's `on*` primitives and projects them onto
 * reactive `$state` bindings. Every imperative method on the core is spread
 * through unchanged — consumers can mix reactive reads (`auth.session`) with
 * imperative calls (`auth.getToken()`, `auth.onSessionChange(...)`). The
 * imperative methods are still useful in non-reactive contexts (fetch
 * interceptors, one-shot callbacks) where subscribing would be a footgun.
 */
export function createAuth(config: CreateAuthConfig): AuthClient {
	const core = createAuthCore(config);

	let token = $state(core.getToken());
	let session = $state(core.getSession());
	let busy = $state(core.isBusy());

	core.onTokenChange((next) => {
		token = next;
	});
	core.onSessionChange((next) => {
		session = next;
	});
	core.onBusyChange((next) => {
		busy = next;
	});

	return {
		...core,
		get token() {
			return token;
		},
		get session() {
			return session;
		},
		get user() {
			return session?.user ?? null;
		},
		get isAuthenticated() {
			return session !== null;
		},
		get isBusy() {
			return busy;
		},
	};
}
