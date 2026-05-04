import { EPICENTER_API_URL } from '@epicenter/constants/apps';
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

export type CreateBearerAuthConfig = {
	/** Resolved once at construction; recreate the client if the origin changes. */
	baseURL?: string;
	initialSession: BearerSession | null;
	saveSession: (value: BearerSession | null) => MaybePromise<void>;
};

export type CreateBrowserAuthConfig = {
	/** Resolved once at construction; recreate the client if the origin changes. */
	baseURL?: string;
	initialIdentity?: AuthIdentity | null;
	saveIdentity?: (value: AuthIdentity | null) => MaybePromise<void>;
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
 * Create an auth client for runtimes that must carry their own bearer token.
 */
export function createBearerAuth({
	baseURL,
	initialSession,
	saveSession,
}: CreateBearerAuthConfig): AuthClient {
	let session: BearerSession | null = initialSession;
	let setCoreIdentity: (next: AuthIdentity | null) => boolean = () => false;

	function saveBearerSession(next: BearerSession | null) {
		void Promise.resolve(saveSession(next)).catch((error) => {
			console.error('[auth] failed to save session:', error);
		});
	}

	function writeLocalSession(
		next: BearerSession | null,
		setIdentity: (next: AuthIdentity | null) => boolean,
	) {
		session = next;
		setIdentity(identityFromSession(next));
		saveBearerSession(next);
	}

	const auth = createAuthCore({
		baseURL,
		initialIdentity: identityFromSession(initialSession),
		fetchOptions: {
			auth: {
				type: 'Bearer',
				token: () => session?.token,
			},
			onSuccess: (context) => {
				const newToken = context.response.headers.get('set-auth-token');
				if (newToken && session !== null && newToken !== session.token) {
					writeLocalSession({ ...session, token: newToken }, setCoreIdentity);
				}
			},
		},
		handleBetterAuthSession(data, setIdentity) {
			let next: BearerSession | null;
			try {
				next = bearerSessionFromBetterAuthSessionResponse(data);
			} catch (error) {
				console.error('[auth] invalid Better Auth session response:', error);
				return;
			}
			if (next === null) {
				if (session !== null) writeLocalSession(null, setIdentity);
				return;
			}
			writeLocalSession(
				{
					token: session?.token ?? next.token,
					user: next.user,
					encryptionKeys: next.encryptionKeys,
				},
				setIdentity,
			);
		},
		clearCredential(setIdentity) {
			writeLocalSession(null, setIdentity);
		},
		fetch(input, init) {
			const headers = headersFromRequest(input, init);
			if (session !== null) {
				headers.set('Authorization', `Bearer ${session.token}`);
			} else {
				headers.delete('Authorization');
			}
			return fetch(input, { ...init, headers, credentials: 'omit' });
		},
		openWebSocket(url, protocols) {
			if (session === null) return null;
			return new WebSocket(
				url,
				websocketProtocolsWithBearer(session.token, protocols),
			);
		},
	});
	setCoreIdentity = auth.setIdentity;

	return auth.client;
}

/**
 * Create an auth client for browser apps that use the first-party cookie jar.
 */
export function createBrowserAuth({
	baseURL,
	initialIdentity = null,
	saveIdentity,
}: CreateBrowserAuthConfig): AuthClient {
	function saveBrowserIdentity(next: AuthIdentity | null) {
		void Promise.resolve(saveIdentity?.(next)).catch((error) => {
			console.error('[auth] failed to save identity:', error);
		});
	}

	const auth = createAuthCore({
		baseURL,
		initialIdentity,
		handleBetterAuthSession(data, setIdentity) {
			let next: BearerSession | null;
			try {
				next = bearerSessionFromBetterAuthSessionResponse(data);
			} catch (error) {
				console.error('[auth] invalid Better Auth session response:', error);
				return;
			}
			const nextIdentity = identityFromSession(next);
			if (setIdentity(nextIdentity)) saveBrowserIdentity(nextIdentity);
		},
		clearCredential(setIdentity) {
			if (setIdentity(null)) saveBrowserIdentity(null);
		},
		fetch(input, init) {
			const headers = headersFromRequest(input, init);
			headers.delete('Authorization');
			return fetch(input, { ...init, headers, credentials: 'include' });
		},
		openWebSocket(url, protocols, identity) {
			if (identity() === null) return null;
			return new WebSocket(url, protocols);
		},
	});

	return auth.client;
}

type AuthCoreConfig = {
	baseURL?: string;
	initialIdentity: AuthIdentity | null;
	fetchOptions?: NonNullable<
		Parameters<typeof createAuthClient>[0]
	>['fetchOptions'];
	handleBetterAuthSession(
		data: unknown,
		setIdentity: (next: AuthIdentity | null) => boolean,
	): void;
	clearCredential(setIdentity: (next: AuthIdentity | null) => boolean): void;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	openWebSocket(
		url: string | URL,
		protocols: string | string[] | undefined,
		identity: () => AuthIdentity | null,
	): WebSocket | null;
};

function createAuthCore({
	baseURL = EPICENTER_API_URL,
	initialIdentity,
	fetchOptions,
	handleBetterAuthSession,
	clearCredential,
	fetch,
	openWebSocket,
}: AuthCoreConfig) {
	let identity: AuthIdentity | null = initialIdentity;
	let hasDisposed = false;
	const { promise: whenReady, resolve: resolveReady } =
		Promise.withResolvers<void>();

	const changeListeners = new Set<AuthChangeListener>();

	function setIdentity(next: AuthIdentity | null) {
		if (identitiesEqual(identity, next)) return false;
		identity = next;
		for (const listener of changeListeners) {
			try {
				listener(next);
			} catch (error) {
				console.error('[auth] subscriber threw:', error);
			}
		}
		return true;
	}

	const betterAuthClient = createAuthClient({
		baseURL,
		basePath: '/auth',
		plugins: [InferPlugin<EpicenterCustomSessionPlugin>()],
		fetchOptions,
	});

	const unsubscribeBetterAuth = betterAuthClient.useSession.subscribe(
		(state) => {
			if (state.isPending) return;
			resolveReady();
			handleBetterAuthSession(state.data, setIdentity);
		},
	);

	const client: AuthClient = {
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
				const { error } = await betterAuthClient.signIn.email(input);
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
				const { error } = await betterAuthClient.signUp.email(input);
				if (error) return AuthError.SignUpFailed({ cause: error });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SignUpFailed({ cause: error });
			}
		},

		async signInWithIdToken({ provider, idToken, nonce }) {
			try {
				const { error } = await betterAuthClient.signIn.social({
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
				await betterAuthClient.signIn.social({ provider, callbackURL });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SocialSignInFailed({ cause: error });
			}
		},

		async signOut() {
			try {
				const { error } = await betterAuthClient.signOut();
				if (error) return AuthError.SignOutFailed({ cause: error });
				clearCredential(setIdentity);
				return Ok(undefined);
			} catch (error) {
				return AuthError.SignOutFailed({ cause: error });
			}
		},

		fetch,
		openWebSocket(url, protocols) {
			return openWebSocket(url, protocols, () => identity);
		},

		[Symbol.dispose]() {
			if (hasDisposed) return;
			hasDisposed = true;
			unsubscribeBetterAuth();
			changeListeners.clear();
		},
	};

	return {
		client,
		setIdentity,
	};
}

function identityFromSession(value: BearerSession | null): AuthIdentity | null {
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

function headersFromRequest(input: Request | string | URL, init?: RequestInit) {
	const headers = new Headers(
		input instanceof Request ? input.headers : undefined,
	);
	new Headers(init?.headers).forEach((value, key) => {
		headers.set(key, value);
	});
	return headers;
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
