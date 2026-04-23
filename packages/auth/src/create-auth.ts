import type { SessionResponse } from '@epicenter/api/types';
import type { BetterAuthOptions } from 'better-auth';
import { createAuthClient, InferPlugin } from 'better-auth/client';
import type { customSession } from 'better-auth/plugins';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { AuthSession, StoredUser } from './auth-types.ts';
import { readStatusCode } from './auth-types.ts';
import type { SessionStore } from './session-store.ts';

export const AuthError = defineErrors({
	InvalidCredentials: () => ({
		message: 'Invalid email or password.',
	}),
	SignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to sign in: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignUpFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to create account: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SocialSignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Social sign-in failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignOutFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to sign out: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type AuthError = InferErrors<typeof AuthError>;

/**
 * Payload returned by a native/extension `socialTokenProvider`. Identifies
 * which Better Auth social provider to verify the ID token against.
 */
export type SocialTokenPayload = {
	provider: string;
	idToken: string;
	nonce: string;
};

export type CreateAuthConfig = {
	/** Resolved once at construction; recreate the client if the origin changes. */
	baseURL: string;
	session: SessionStore;
	/**
	 * Platform-specific credential provider for social ID token sign-in.
	 *
	 * Injected at creation time so the auth client can orchestrate the full
	 * popup flow without pushing platform logic into UI components. Native
	 * apps and extensions provide this; web apps that only use redirect
	 * sign-in can omit it.
	 */
	socialTokenProvider?: () => Promise<SocialTokenPayload>;
};

export type AuthCore = {
	getToken(): string | null;
	getSession(): AuthSession | null;
	getUser(): StoredUser | null;
	isAuthenticated(): boolean;
	isBusy(): boolean;

	/**
	 * Called on every session transition with `(next, previous)`. Replays
	 * synchronously on subscribe with `(current, null)`.
	 */
	onSessionChange(
		fn: (next: AuthSession | null, previous: AuthSession | null) => void,
	): () => void;
	/**
	 * Called when the session token changes (including rotation). Replays
	 * synchronously on subscribe with the current token.
	 */
	onTokenChange(fn: (token: string | null) => void): () => void;
	/**
	 * Fires on the `null → session` transition. Replays synchronously on
	 * subscribe only if a session already exists.
	 */
	onLogin(fn: (session: AuthSession) => void): () => void;
	/**
	 * Fires on the `session → null` transition. Does NOT replay on subscribe.
	 */
	onLogout(fn: () => void): () => void;
	/**
	 * Fires when the in-flight auth-op counter flips between zero and
	 * non-zero. Replays synchronously on subscribe with the current state.
	 */
	onBusyChange(fn: (busy: boolean) => void): () => void;

	signIn(input: {
		email: string;
		password: string;
	}): Promise<Result<undefined, AuthError>>;
	signUp(input: {
		email: string;
		password: string;
		name: string;
	}): Promise<Result<undefined, AuthError>>;
	signInWithSocialPopup(): Promise<Result<undefined, AuthError>>;
	signInWithSocialRedirect(input: {
		provider: string;
		callbackURL: string;
	}): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

	[Symbol.dispose](): void;
};

/**
 * Compile-time bridge for Better Auth's custom session type inference.
 *
 * `customSessionClient<typeof auth>()` is the canonical pattern but drags in
 * server-only types that client packages in a monorepo can't resolve.
 * `InferPlugin<T>()` sets the same `$InferServerPlugin` property without
 * requiring a fabricated auth shape.
 */
type EpicenterCustomSessionPlugin = ReturnType<
	typeof customSession<SessionResponse, BetterAuthOptions>
>;

/**
 * Create a framework-agnostic auth client.
 *
 * Owns the Better Auth transport, the session-rotation interceptor, and the
 * imperative subscription fan-out. Consumers pass in a `SessionStore` — the
 * core reads and writes it, but never persists.
 *
 * Firing order on any session transition:
 * 1. `session.set(next)` is called; `getSession()` now returns `next`.
 * 2. The store's watch callback runs and triggers notification.
 * 3. `onSessionChange` subscribers fire with `(next, previous)`.
 * 4. `onLogin` fires if the transition was `null → session`.
 * 5. `onLogout` fires if the transition was `session → null`.
 * 6. `onTokenChange` fires if `previous?.token !== next?.token`.
 *
 * Every subscriber runs in its own try/catch — one throwing does not prevent
 * others from firing. `isBusy` is an in-flight counter, not a boolean, so
 * overlapping ops don't flip busy false prematurely.
 */
export function createAuth({
	baseURL,
	session,
	socialTokenProvider,
}: CreateAuthConfig): AuthCore {
	let busyCount = 0;

	const sessionSubs = new Set<
		(next: AuthSession | null, previous: AuthSession | null) => void
	>();
	const tokenSubs = new Set<(token: string | null) => void>();
	const loginSubs = new Set<(s: AuthSession) => void>();
	const logoutSubs = new Set<() => void>();
	const busySubs = new Set<(busy: boolean) => void>();

	const disposers: Array<() => void> = [];

	function safeRun(fn: () => void) {
		try {
			fn();
		} catch (error) {
			console.error('[auth] subscriber threw:', error);
		}
	}

	function notifySession(
		next: AuthSession | null,
		previous: AuthSession | null,
	) {
		for (const sub of sessionSubs) safeRun(() => sub(next, previous));
		if (previous === null && next !== null) {
			for (const sub of loginSubs) safeRun(() => sub(next));
		} else if (previous !== null && next === null) {
			for (const sub of logoutSubs) safeRun(() => sub());
		}
		const prevToken = previous?.token ?? null;
		const nextToken = next?.token ?? null;
		if (prevToken !== nextToken) {
			for (const sub of tokenSubs) safeRun(() => sub(nextToken));
		}
	}

	function notifyBusyChange(busy: boolean) {
		for (const sub of busySubs) safeRun(() => sub(busy));
	}

	async function runBusy<T>(fn: () => Promise<T>): Promise<T> {
		const wasIdle = busyCount === 0;
		busyCount++;
		if (wasIdle) notifyBusyChange(true);
		try {
			return await fn();
		} finally {
			busyCount--;
			if (busyCount === 0) notifyBusyChange(false);
		}
	}

	// The store's watch callback is our single notification path. Every
	// mutation (our own session.set, the BA onSuccess rotation, the
	// useSession subscription) goes through session.set, which triggers
	// this handler — so we never have to fire notifySession manually.
	let lastSeen: AuthSession | null = session.get();
	disposers.push(
		session.watch((next) => {
			const previous = lastSeen;
			if (previous === next) return;
			lastSeen = next;
			notifySession(next, previous);
		}),
	);

	const client = createAuthClient({
		baseURL,
		basePath: '/auth',
		plugins: [InferPlugin<EpicenterCustomSessionPlugin>()],
		fetchOptions: {
			auth: {
				type: 'Bearer',
				token: () => session.get()?.token,
			},
			// BA silently rotates tokens on authenticated requests. The new
			// token arrives in a response header rather than through the
			// useSession subscription, so we intercept it here and write it
			// to the session store — otherwise the local copy goes stale
			// and subsequent requests use an expired token.
			onSuccess: (context) => {
				const newToken = context.response.headers.get('set-auth-token');
				const current = session.get();
				if (newToken && current !== null && newToken !== current.token) {
					session.set({ ...current, token: newToken });
				}
			},
		},
	});

	// Field-level write ownership between the two session writers:
	//
	// - onSuccess: owns the TOKEN field (immediate rotation via
	//   set-auth-token header — old token is revoked, can't wait).
	// - useSession.subscribe: owns USER and ENCRYPTIONKEYS (initial
	//   session, profile updates, key rotation, account switch).
	//
	// Token strategy: preserve current.token if we already have a session
	// (onSuccess may have rotated it and BA's async refetch can emit a
	// stale pre-rotation value). On initial establishment (current is
	// null), use BA's token.
	const unsubBA = client.useSession.subscribe((state) => {
		if (state.isPending) return;
		const current = session.get();
		if (state.data) {
			session.set({
				token: current?.token ?? state.data.session.token,
				user: normalizeUser(state.data.user),
				encryptionKeys: state.data.encryptionKeys,
			});
		} else if (current !== null) {
			session.set(null);
		}
	});
	disposers.push(() => {
		if (typeof unsubBA === 'function') unsubBA();
	});

	return {
		getToken: () => session.get()?.token ?? null,
		getSession: () => session.get(),
		getUser: () => session.get()?.user ?? null,
		isAuthenticated: () => session.get() !== null,
		isBusy: () => busyCount > 0,

		onSessionChange(fn) {
			safeRun(() => fn(session.get(), null));
			sessionSubs.add(fn);
			return () => {
				sessionSubs.delete(fn);
			};
		},
		onTokenChange(fn) {
			safeRun(() => fn(session.get()?.token ?? null));
			tokenSubs.add(fn);
			return () => {
				tokenSubs.delete(fn);
			};
		},
		onLogin(fn) {
			const current = session.get();
			if (current !== null) safeRun(() => fn(current));
			loginSubs.add(fn);
			return () => {
				loginSubs.delete(fn);
			};
		},
		onLogout(fn) {
			logoutSubs.add(fn);
			return () => {
				logoutSubs.delete(fn);
			};
		},
		onBusyChange(fn) {
			safeRun(() => fn(busyCount > 0));
			busySubs.add(fn);
			return () => {
				busySubs.delete(fn);
			};
		},

		async signIn(input) {
			return runBusy(async () => {
				try {
					const { error } = await client.signIn.email(input);
					if (!error) return Ok(undefined);
					const status = readStatusCode(error);
					if (status === 401 || status === 403)
						return AuthError.InvalidCredentials();
					return AuthError.SignInFailed({ cause: error });
				} catch (error) {
					return AuthError.SignInFailed({ cause: error });
				}
			});
		},

		async signUp(input) {
			return runBusy(async () => {
				try {
					const { error } = await client.signUp.email(input);
					if (error) return AuthError.SignUpFailed({ cause: error });
					return Ok(undefined);
				} catch (error) {
					return AuthError.SignUpFailed({ cause: error });
				}
			});
		},

		async signInWithSocialPopup() {
			if (!socialTokenProvider) {
				return AuthError.SocialSignInFailed({
					cause: new Error('No socialTokenProvider configured.'),
				});
			}
			return runBusy(async () => {
				try {
					const { provider, idToken, nonce } = await socialTokenProvider();
					const { error } = await client.signIn.social({
						provider,
						idToken: { token: idToken, nonce },
					});
					if (error) return AuthError.SocialSignInFailed({ cause: error });
					return Ok(undefined);
				} catch (error) {
					return AuthError.SocialSignInFailed({ cause: error });
				}
			});
		},

		// Not wrapped in runBusy — the page navigates away on success, so
		// isBusy is never read. The promise never resolves on the happy path.
		async signInWithSocialRedirect({ provider, callbackURL }) {
			try {
				await client.signIn.social({ provider, callbackURL });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SocialSignInFailed({ cause: error });
			}
		},

		async signOut() {
			return runBusy(async () => {
				try {
					await client.signOut();
					return Ok(undefined);
				} catch (error) {
					return AuthError.SignOutFailed({ cause: error });
				}
			});
		},

		fetch(input, init) {
			const headers = new Headers(init?.headers);
			const token = session.get()?.token;
			if (token) headers.set('Authorization', `Bearer ${token}`);
			return fetch(input, { ...init, headers, credentials: 'include' });
		},

		[Symbol.dispose]() {
			for (const dispose of disposers) {
				try {
					dispose();
				} catch (error) {
					console.error('[auth] dispose error:', error);
				}
			}
			sessionSubs.clear();
			tokenSubs.clear();
			loginSubs.clear();
			logoutSubs.clear();
			busySubs.clear();
		},
	};
}

/**
 * Convert BA's `Date` fields to ISO strings for JSON-safe persistence.
 *
 * BA returns `createdAt` and `updatedAt` as `Date` objects. Persisted session
 * stores (chrome.storage, localStorage) need plain JSON, so we normalize here
 * at the boundary rather than forcing every consumer to handle it.
 */
function normalizeUser(user: {
	id: string;
	createdAt: Date;
	updatedAt: Date;
	email: string;
	emailVerified: boolean;
	name: string;
	image?: string | null;
}): StoredUser {
	return {
		id: user.id,
		createdAt: user.createdAt.toISOString(),
		updatedAt: user.updatedAt.toISOString(),
		email: user.email,
		emailVerified: user.emailVerified,
		name: user.name,
		image: user.image,
	};
}
