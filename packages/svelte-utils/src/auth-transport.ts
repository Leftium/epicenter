import type { User } from 'better-auth';
import { createAuthClient } from 'better-auth/client';
import type { AuthSession, StoredUser } from './auth-types.js';

type BaseURL = string | (() => string);

export type SessionResolution =
	| {
			status: 'authenticated';
			token: string;
			user: StoredUser;
			userKeyBase64?: string | null;
	  }
	| { status: 'anonymous' }
	| { status: 'unchanged' };

export type RemoteAuthResult = SessionResolution;

export type ResolveSession = (
	current: AuthSession,
) => Promise<SessionResolution>;

export type AuthTransport = ReturnType<typeof createAuthTransport>;

type BetterAuthClient = ReturnType<typeof createAuthClient>;
type GetSessionResult = Awaited<ReturnType<BetterAuthClient['getSession']>>;
type GetSessionData = NonNullable<GetSessionResult['data']>;
type SignInEmailResult = Awaited<
	ReturnType<BetterAuthClient['signIn']['email']>
>;
type SignInEmailData = NonNullable<SignInEmailResult['data']>;
type SignUpEmailResult = Awaited<
	ReturnType<BetterAuthClient['signUp']['email']>
>;
type SignUpEmailData = NonNullable<SignUpEmailResult['data']>;
type SignInSocialResult = Awaited<
	ReturnType<BetterAuthClient['signIn']['social']>
>;
type SignInSocialData = NonNullable<SignInSocialResult['data']>;
type CompletedSocialSignInData = Extract<
	SignInSocialData,
	{ token: string; user: User }
>;
type AuthCommandTokenPayload =
	| SignInEmailData
	| SignUpEmailData
	| CompletedSocialSignInData
	| null
	| undefined;

/**
 * Create the shared Better Auth transport used by Epicenter apps.
 *
 * This wrapper keeps auth operations on top of Better Auth while translating
 * responses into the smaller local union consumed by auth state and workspace
 * boot. The browser extension can swap only the Google entrypoint while keeping
 * the rest of the transport behavior consistent.
 */
export function createAuthTransport({ baseURL }: { baseURL: BaseURL }) {
	function createClientSession(authToken: string | null) {
		const bearerToken = createBearerTokenState(authToken);

		const client = createAuthClient({
			baseURL: typeof baseURL === 'function' ? baseURL() : baseURL,
			basePath: '/auth',
			fetchOptions: {
				auth: {
					type: 'Bearer',
					token: () => bearerToken.getCurrentToken() ?? undefined,
				},
				onSuccess: ({ response }) => {
					bearerToken.rememberTokenFromHeaders(response);
				},
			},
		});

		return {
			client,
			bearerToken,
		};
	}

	async function resolveSessionWithToken(
		authToken: string | null,
	): Promise<SessionResolution> {
		const { client, bearerToken } = createClientSession(authToken);
		const { data, error } = await client.getSession();

		if (error) {
			const status =
				typeof error === 'object' &&
				error !== null &&
				'status' in error &&
				typeof error.status === 'number'
					? error.status
					: undefined;

			return status !== undefined && status < 500
				? { status: 'anonymous' }
				: { status: 'unchanged' };
		}

		if (!data) return { status: 'anonymous' };

		bearerToken.rememberTokenFromSessionPayload(data);

		return {
			status: 'authenticated',
			token: bearerToken.requireAuthenticatedToken(),
			user: {
				id: data.user.id,
				createdAt: data.user.createdAt.toISOString(),
				updatedAt: data.user.updatedAt.toISOString(),
				email: data.user.email,
				emailVerified: data.user.emailVerified,
				name: data.user.name,
				image: data.user.image,
			} satisfies StoredUser,
			userKeyBase64: readEpicenterUserKeyBase64(data),
		};
	}

	return {
		/**
		 * Refresh the remote auth session using the caller's current local token
		 * when one exists.
		 */
		resolveSession(current: AuthSession): Promise<SessionResolution> {
			return resolveSessionWithToken(
				current.status === 'authenticated' ? current.token : null,
			);
		},

		/**
		 * Sign in with email/password, then normalize the remote session using the
		 * same resolution path as boot and refresh.
		 */
		async signInWithPassword(input: {
			email: string;
			password: string;
		}): Promise<SessionResolution> {
			const { client, bearerToken } = createClientSession(null);
			const { data, error } = await client.signIn.email(input);
			if (error) {
				throw error;
			}

			bearerToken.rememberTokenFromAuthCommandPayload(data);
			return await resolveSessionWithToken(bearerToken.getCurrentToken());
		},

		/**
		 * Create an account with email/password, then normalize the remote session.
		 */
		async signUpWithPassword(input: {
			email: string;
			password: string;
			name: string;
		}): Promise<SessionResolution> {
			const { client, bearerToken } = createClientSession(null);
			const { data, error } = await client.signUp.email(input);
			if (error) {
				throw error;
			}

			bearerToken.rememberTokenFromAuthCommandPayload(data);
			return await resolveSessionWithToken(bearerToken.getCurrentToken());
		},

		/**
		 * Sign out the remote Better Auth session.
		 *
		 * Anonymous sessions are treated as already signed out so local sign-out
		 * flows stay idempotent.
		 */
		async signOutRemote(current: AuthSession): Promise<void> {
			if (current.status !== 'authenticated') return;

			const { client } = createClientSession(current.token);
			const { error } = await client.signOut();
			if (error) {
				throw error;
			}
		},

		/**
		 * Start a Google OAuth redirect in browser-based clients.
		 *
		 * The browser extension uses a custom `chrome.identity` entrypoint instead,
		 * then rejoins the shared session resolution flow afterwards.
		 */
		async startGoogleSignInRedirect({
			callbackURL,
		}: {
			callbackURL: string;
		}): Promise<void> {
			const { client } = createClientSession(null);

			await client.signIn.social({
				provider: 'google',
				callbackURL,
			});
		},

		/**
		 * Complete a Google sign-in flow that already has an ID token.
		 *
		 * This is used by the browser extension after `chrome.identity` completes
		 * and needs to re-enter the shared session resolution path.
		 */
		async signInWithGoogleIdToken({
			idToken,
			nonce,
		}: {
			idToken: string;
			nonce: string;
		}): Promise<SessionResolution> {
			const { client, bearerToken } = createClientSession(null);
			const { data, error } = await client.signIn.social({
				provider: 'google',
				idToken: { token: idToken, nonce },
			});
			if (error) throw new Error(error.message ?? error.statusText);
			if (!data || !('token' in data) || !('user' in data)) {
				throw new Error('Unexpected response from server');
			}

			bearerToken.rememberTokenFromAuthCommandPayload(data);
			return await resolveSessionWithToken(bearerToken.getCurrentToken());
		},
	};
}

function createBearerTokenState(authToken: string | null) {
	let currentToken: string | null | undefined;

	function getCurrentToken() {
		return currentToken === undefined ? authToken : currentToken;
	}

	return {
		getCurrentToken,
		rememberTokenFromHeaders(response: Response) {
			const nextToken = response.headers.get('set-auth-token');
			if (nextToken !== null) {
				currentToken = nextToken || null;
			}
		},
		rememberTokenFromSessionPayload(data: GetSessionData) {
			currentToken = data.session.token;
		},
		rememberTokenFromAuthCommandPayload(data?: AuthCommandTokenPayload) {
			const nextToken = readAuthCommandToken(data);
			if (nextToken !== null) {
				currentToken = nextToken;
			}
		},
		requireAuthenticatedToken() {
			const token = getCurrentToken();
			if (!token) {
				throw new Error('Authenticated session is missing bearer token');
			}

			return token;
		},
	};
}

function readEpicenterUserKeyBase64(
	data: GetSessionData,
): string | null | undefined {
	return (data as GetSessionData & { encryptionKey?: string | null }).encryptionKey;
}

function readAuthCommandToken(
	data?: AuthCommandTokenPayload,
): string | null {
	if (
		typeof data === 'object' &&
		data !== null &&
		'token' in data &&
		typeof data.token === 'string'
	) {
		return data.token;
	}

	if (
		typeof data === 'object' &&
		data !== null &&
		'session' in data &&
		typeof data.session === 'object' &&
		data.session !== null &&
		'token' in data.session &&
		typeof data.session.token === 'string'
	) {
		return data.session.token;
	}

	return null;
}
