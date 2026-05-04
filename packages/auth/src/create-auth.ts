import { encryptionKeysEqual } from '@epicenter/encryption';
import { BEARER_SUBPROTOCOL_PREFIX, MAIN_SUBPROTOCOL } from '@epicenter/sync';
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
	AuthChangeListener,
	AuthIdentity,
	AuthUser,
	BearerSession,
} from './auth-types.ts';
import {
	type BetterAuthSessionResponse,
	bearerSessionFromBetterAuthSessionResponse,
} from './contracts/auth-session.ts';

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

export type CreateAuthConfig = {
	/** Resolved once at construction; recreate the client if the origin changes. */
	baseURL: string;
	initialSession: BearerSession | null;
	saveSession: (value: BearerSession | null) => MaybePromise<void>;
};

type MaybePromise<T> = T | Promise<T>;

export type AuthClient = {
	readonly identity: AuthIdentity | null;
	readonly whenReady: Promise<void>;
	onChange(fn: AuthChangeListener): () => void;
	signIn(input: {
		email: string;
		password: string;
	}): Promise<Result<undefined, AuthError>>;
	signUp(input: {
		email: string;
		password: string;
		name: string;
	}): Promise<Result<undefined, AuthError>>;
	signInWithIdToken(input: {
		provider: string;
		idToken: string;
		nonce: string;
	}): Promise<Result<undefined, AuthError>>;
	signInWithSocialRedirect(input: {
		provider: string;
		callbackURL: string;
	}): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	openWebSocket(
		url: string | URL,
		protocols?: string | string[],
	): WebSocket | null;

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
	typeof customSession<BetterAuthSessionResponse, BetterAuthOptions>
>;

/**
 * Create a framework-agnostic auth client.
 *
 * Owns the Better Auth transport, response-header token rotation, storage
 * persistence, and identity subscription fan-out. The getter only reads the
 * in-memory identity created from the caller-provided initial session.
 */
export function createAuth({
	baseURL,
	initialSession,
	saveSession,
}: CreateAuthConfig): AuthClient {
	let session: BearerSession | null = initialSession;
	let identity: AuthIdentity | null = identityFromSession(initialSession);
	let hasDisposed = false;
	const { promise: whenReady, resolve: resolveReady } =
		Promise.withResolvers<void>();

	const changeListeners = new Set<AuthChangeListener>();

	function identityFromSession(
		value: BearerSession | null,
	): AuthIdentity | null {
		if (value === null) return null;
		return {
			user: value.user,
			encryptionKeys: value.encryptionKeys,
		};
	}

	function identitiesEqual(
		left: AuthIdentity | null,
		right: AuthIdentity | null,
	) {
		if (left === null || right === null) return left === right;
		return (
			usersEqual(left.user, right.user) &&
			encryptionKeysEqual(left.encryptionKeys, right.encryptionKeys)
		);
	}

	function setIdentity(next: AuthIdentity | null) {
		if (identitiesEqual(identity, next)) return;
		identity = next;
		for (const listener of changeListeners) {
			try {
				listener(next);
			} catch (error) {
				console.error('[auth] subscriber threw:', error);
			}
		}
	}

	function saveBearerSession(next: BearerSession | null) {
		void Promise.resolve(saveSession(next)).catch((error) => {
			console.error('[auth] failed to save session:', error);
		});
	}

	function writeLocalSession(next: BearerSession | null) {
		session = next;
		setIdentity(identityFromSession(next));
		saveBearerSession(next);
	}

	function websocketProtocolsWithBearer(
		token: string,
		protocols?: string | string[],
	): string[] {
		const offered =
			protocols === undefined
				? [MAIN_SUBPROTOCOL]
				: Array.isArray(protocols)
					? [...protocols]
					: [protocols];
		if (!offered.includes(MAIN_SUBPROTOCOL)) {
			offered.unshift(MAIN_SUBPROTOCOL);
		}
		offered.push(`${BEARER_SUBPROTOCOL_PREFIX}${token}`);
		return offered;
	}

	const client = createAuthClient({
		baseURL,
		basePath: '/auth',
		plugins: [InferPlugin<EpicenterCustomSessionPlugin>()],
		fetchOptions: {
			auth: {
				type: 'Bearer',
				token: () => session?.token,
			},
			onSuccess: (context) => {
				const newToken = context.response.headers.get('set-auth-token');
				if (newToken && session !== null && newToken !== session.token) {
					writeLocalSession({ ...session, token: newToken });
				}
			},
		},
	});

	const unsubscribeBetterAuth = client.useSession.subscribe((state) => {
		if (state.isPending) return;
		resolveReady();
		let next: BearerSession | null;
		try {
			next = bearerSessionFromBetterAuthSessionResponse(state.data);
		} catch (error) {
			console.error('[auth] invalid Better Auth session response:', error);
			return;
		}
		if (next === null) {
			if (session !== null) writeLocalSession(null);
			return;
		}
		writeLocalSession({
			token: session?.token ?? next.token,
			user: next.user,
			encryptionKeys: next.encryptionKeys,
		});
	});

	return {
		get identity() {
			return identity;
		},
		whenReady,
		onChange(fn) {
			changeListeners.add(fn);
			return () => {
				changeListeners.delete(fn);
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

		async signInWithIdToken({ provider, idToken, nonce }) {
			try {
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
				writeLocalSession(null);
				return Ok(undefined);
			} catch (error) {
				return AuthError.SignOutFailed({ cause: error });
			}
		},

		fetch(input, init) {
			const headers = new Headers(init?.headers);
			if (session !== null) {
				headers.set('Authorization', `Bearer ${session.token}`);
			}
			return fetch(input, { ...init, headers, credentials: 'include' });
		},

		openWebSocket(url, protocols) {
			if (session === null) return null;
			return new WebSocket(
				url,
				websocketProtocolsWithBearer(session.token, protocols),
			);
		},

		[Symbol.dispose]() {
			if (hasDisposed) return;
			hasDisposed = true;
			unsubscribeBetterAuth();
			changeListeners.clear();
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
