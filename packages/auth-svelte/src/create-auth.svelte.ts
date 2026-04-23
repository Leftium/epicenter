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
export type AuthClient = Omit<
	AuthCore,
	'getToken' | 'getSession' | 'getUser' | 'isAuthenticated' | 'isBusy'
> & {
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
 * reactive boxes. The returned object also re-exposes every imperative
 * method from the core (including `on*` registrations and
 * `[Symbol.dispose]`), so consumers can mix reactive reads with imperative
 * subscriptions — the workspace `applySession` wiring is one of those
 * imperative consumers.
 */
export function createAuth(config: CreateAuthConfig): AuthClient {
	const core = createAuthCore(config);

	const token = $state<{ current: string | null }>({
		current: core.getToken(),
	});
	const session = $state<{ current: AuthSession | null }>({
		current: core.getSession(),
	});
	const busy = $state<{ current: boolean }>({ current: core.isBusy() });

	core.onTokenChange((next) => {
		token.current = next;
	});
	core.onSessionChange((next) => {
		session.current = next;
	});
	core.onBusyChange((next) => {
		busy.current = next;
	});

	return {
		onSessionChange: core.onSessionChange,
		onTokenChange: core.onTokenChange,
		onLogin: core.onLogin,
		onLogout: core.onLogout,
		onBusyChange: core.onBusyChange,
		signIn: core.signIn,
		signUp: core.signUp,
		signInWithSocialPopup: core.signInWithSocialPopup,
		signInWithSocialRedirect: core.signInWithSocialRedirect,
		signOut: core.signOut,
		fetch: core.fetch,
		[Symbol.dispose]: core[Symbol.dispose].bind(core),

		get token() {
			return token.current;
		},
		get session() {
			return session.current;
		},
		get user() {
			return session.current?.user ?? null;
		},
		get isAuthenticated() {
			return session.current !== null;
		},
		get isBusy() {
			return busy.current;
		},
	};
}
