import { encryptionKeysEqual } from '@epicenter/encryption';
import type { BetterAuthOptions } from 'better-auth';
import { createAuthClient, InferPlugin } from 'better-auth/client';
import type { customSession } from 'better-auth/plugins';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type {
	AuthSession,
	AuthSnapshot,
	AuthSnapshotChangeListener,
	AuthUser,
} from './auth-types.ts';
import {
	authSessionFromBetterAuthSessionResponse,
	type BetterAuthSessionResponse,
} from './contracts/auth-session.ts';
import type { MaybePromise, SessionStorage } from './session-store.ts';

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
	sessionStorage: SessionStorage;
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

export type AuthClient = {
	readonly snapshot: AuthSnapshot;
	readonly whenLoaded: Promise<void>;
	onSnapshotChange(fn: AuthSnapshotChangeListener): () => void;
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
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;

	[Symbol.dispose](): void;
};

export type SessionStateAdapter = {
	get(): AuthSession | null;
	set(value: AuthSession | null): MaybePromise<void>;
	whenReady?: Promise<unknown>;
};

export function createSessionStorageAdapter(
	state: SessionStateAdapter,
): SessionStorage {
	return {
		async load() {
			await state.whenReady;
			return state.get();
		},
		save: (value) => state.set(value),
	};
}

/**
 * Compile-time bridge for Better Auth's custom session type inference.
 *
 * `customSessionClient<typeof auth>()` is the canonical pattern but drags in
 * server-only types that client packages in a monorepo can't resolve.
 * `InferPlugin<T>()` sets the same `$InferServerPlugin` property without
 * requiring a fabricated auth shape.
 */
type EpicenterCustomSessionPlugin = ReturnType<
	typeof customSession<BetterAuthSessionResponse, BetterAuthOptions>
>;

/**
 * Create a framework-agnostic auth client.
 *
 * Owns the Better Auth transport, response-header token rotation, storage
 * hydration, and snapshot subscription fan-out. The getter only reads the
 * in-memory snapshot.
 */
export function createAuth({
	baseURL,
	sessionStorage,
	socialTokenProvider,
}: CreateAuthConfig): AuthClient {
	let snapshot: AuthSnapshot = { status: 'loading' };
	let disposed = false;
	let unsubscribeBetterAuth: (() => void) | null = null;
	let resolveDisposeSignal: () => void = () => {};
	const disposeSignal = new Promise<void>((resolve) => {
		resolveDisposeSignal = resolve;
	});

	const snapshotChangeListeners = new Set<AuthSnapshotChangeListener>();

	function sessionFromSnapshot(value: AuthSnapshot): AuthSession | null {
		return value.status === 'signedIn' ? value.session : null;
	}

	function snapshotFromSession(session: AuthSession | null): AuthSnapshot {
		return session === null
			? { status: 'signedOut' }
			: { status: 'signedIn', session };
	}

	function sessionsEqual(left: AuthSession | null, right: AuthSession | null) {
		if (left === null || right === null) return left === right;
		return (
			left.token === right.token &&
			usersEqual(left.user, right.user) &&
			encryptionKeysEqual(left.encryptionKeys, right.encryptionKeys)
		);
	}

	function snapshotsEqual(left: AuthSnapshot, right: AuthSnapshot) {
		if (left.status !== right.status) return false;
		if (left.status !== 'signedIn' || right.status !== 'signedIn') return true;
		return sessionsEqual(left.session, right.session);
	}

	function setSnapshot(next: AuthSnapshot) {
		if (disposed) return;
		if (snapshotsEqual(snapshot, next)) return;
		snapshot = next;
		for (const listener of snapshotChangeListeners) {
			try {
				listener(next);
			} catch (error) {
				console.error('[auth] subscriber threw:', error);
			}
		}
	}

	function saveSnapshot(next: AuthSnapshot) {
		if (disposed) return;
		void Promise.resolve(sessionStorage.save(sessionFromSnapshot(next))).catch(
			(error) => {
				console.error('[auth] failed to save session:', error);
			},
		);
	}

	function writeLocalSnapshot(next: AuthSnapshot) {
		setSnapshot(next);
		saveSnapshot(next);
	}

	const client = createAuthClient({
		baseURL,
		basePath: '/auth',
		plugins: [InferPlugin<EpicenterCustomSessionPlugin>()],
		fetchOptions: {
			auth: {
				type: 'Bearer',
				token: () =>
					snapshot.status === 'signedIn' ? snapshot.session.token : undefined,
			},
			onSuccess: (context) => {
				const newToken = context.response.headers.get('set-auth-token');
				if (
					newToken &&
					snapshot.status === 'signedIn' &&
					newToken !== snapshot.session.token
				) {
					writeLocalSnapshot({
						status: 'signedIn',
						session: { ...snapshot.session, token: newToken },
					});
				}
			},
		},
	});

	const whenLoaded: Promise<void> = Promise.race([
		(async () => {
			let loaded: AuthSession | null;
			try {
				loaded = await sessionStorage.load();
			} catch (error) {
				console.error('[auth] failed to load session:', error);
				loaded = null;
			}
			if (disposed) return;
			setSnapshot(snapshotFromSession(loaded));

			unsubscribeBetterAuth = client.useSession.subscribe((state) => {
				if (disposed || state.isPending) return;
				let next: AuthSession | null;
				try {
					next = authSessionFromBetterAuthSessionResponse(state.data);
				} catch (error) {
					console.error(
						'[auth] invalid Better Auth session response:',
						error,
					);
					return;
				}
				if (next === null) {
					if (snapshot.status === 'signedIn')
						writeLocalSnapshot({ status: 'signedOut' });
					return;
				}
				const current = sessionFromSnapshot(snapshot);
				writeLocalSnapshot({
					status: 'signedIn',
					session: {
						token: current?.token ?? next.token,
						user: next.user,
						encryptionKeys: next.encryptionKeys,
					},
				});
			});
		})(),
		disposeSignal,
	]);

	return {
		get snapshot() {
			return snapshot;
		},
		whenLoaded,
		onSnapshotChange(fn) {
			snapshotChangeListeners.add(fn);
			return () => {
				snapshotChangeListeners.delete(fn);
			};
		},

		async signIn(input) {
			try {
				const { error } = await client.signIn.email(input);
				if (!error) return Ok(undefined);
				if (error.status === 401 || error.status === 403)
					return AuthError.InvalidCredentials();
				return AuthError.SignInFailed({ cause: error });
			} catch (error) {
				return AuthError.SignInFailed({ cause: error });
			}
		},

		async signUp(input) {
			try {
				const { error } = await client.signUp.email(input);
				if (error) return AuthError.SignUpFailed({ cause: error });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SignUpFailed({ cause: error });
			}
		},

		async signInWithSocialPopup() {
			if (!socialTokenProvider) {
				return AuthError.SocialSignInFailed({
					cause: new Error('No socialTokenProvider configured.'),
				});
			}
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
		},

		async signInWithSocialRedirect({ provider, callbackURL }) {
			try {
				await client.signIn.social({ provider, callbackURL });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SocialSignInFailed({ cause: error });
			}
		},

		async signOut() {
			try {
				const { error } = await client.signOut();
				if (error) return AuthError.SignOutFailed({ cause: error });
				writeLocalSnapshot({ status: 'signedOut' });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SignOutFailed({ cause: error });
			}
		},

		async fetch(input, init) {
			await whenLoaded;
			const headers = new Headers(init?.headers);
			if (snapshot.status === 'signedIn') {
				headers.set('Authorization', `Bearer ${snapshot.session.token}`);
			}
			return fetch(input, { ...init, headers, credentials: 'include' });
		},

		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			// Awaiters of whenLoaded proceed after teardown but observe { status: 'loading' }.
			resolveDisposeSignal();
			unsubscribeBetterAuth?.();
			snapshotChangeListeners.clear();
		},
	};
}

function usersEqual(left: AuthUser, right: AuthUser) {
	return (
		left.id === right.id &&
		left.createdAt === right.createdAt &&
		left.updatedAt === right.updatedAt &&
		left.email === right.email &&
		left.emailVerified === right.emailVerified &&
		left.name === right.name &&
		left.image === right.image
	);
}
