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
type SignInSocialResult = Awaited<
	ReturnType<BetterAuthClient['signIn']['social']>
>;
type SignInSocialData = NonNullable<SignInSocialResult['data']>;
type CompletedSocialSignInData = Extract<
	SignInSocialData,
	{ token: string; user: User }
>;
type IssuedTokenPayload =
	| GetSessionData
	| SignInEmailData
	| CompletedSocialSignInData
	| null
	| undefined;

/**
 * Epicenter extends Better Auth's session payload with an optional encrypted
 * workspace key. Better Auth's generated client types do not know about this
 * field, so we keep the cast isolated to one helper instead of letting
 * `encryptionKey` access leak through the transport flow.
 *
 * This should go away if the field is ever modeled through a Better Auth plugin
 * or another typed client extension point.
 */
type EpicenterSessionData = GetSessionData & {
	encryptionKey?: string | null;
};

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
		let issuedToken: string | null | undefined;
		function getCurrentToken() {
			return issuedToken === undefined ? authToken : issuedToken;
		}

		const client = createAuthClient({
			baseURL: resolveBaseURL(baseURL),
			basePath: '/auth',
			fetchOptions: {
				auth: {
					type: 'Bearer',
					token: () => getCurrentToken() ?? undefined,
				},
				onSuccess: ({ response }) => {
					const nextToken = response.headers.get('set-auth-token');
					if (nextToken !== null) {
						issuedToken = nextToken || null;
					}
				},
			},
		});

		return {
			client,
			getIssuedToken(payload?: IssuedTokenPayload) {
				const payloadToken = readAuthToken(payload);
				if (payloadToken !== null) {
					issuedToken = payloadToken;
				}

				return getCurrentToken() ?? null;
			},
		};
	}

	async function resolveSessionWithToken(
		authToken: string | null,
	): Promise<SessionResolution> {
		const { client, getIssuedToken } = createClientSession(authToken);
		const { data, error } = await client.getSession();

		if (error) {
			const status = getErrorStatus(error);

			return status !== undefined && status < 500
				? { status: 'anonymous' }
				: { status: 'unchanged' };
		}

		if (!data) return { status: 'anonymous' };

		const token = getIssuedToken(data);
		if (!token) {
			throw new Error('Authenticated session is missing bearer token');
		}

		return {
			status: 'authenticated',
			token,
			user: toStoredUser(data.user),
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
			const { client, getIssuedToken } = createClientSession(null);
			const { data, error } = await client.signIn.email(input);
			if (error) {
				throw error;
			}

			return await resolveSessionWithToken(getIssuedToken(data));
		},

		/**
		 * Create an account with email/password, then normalize the remote session.
		 */
		async signUpWithPassword(input: {
			email: string;
			password: string;
			name: string;
		}): Promise<SessionResolution> {
			const { client, getIssuedToken } = createClientSession(null);
			const { data, error } = await client.signUp.email(input);
			if (error) {
				throw error;
			}

			return await resolveSessionWithToken(getIssuedToken(data));
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
			const { client, getIssuedToken } = createClientSession(null);
			const { data, error } = await client.signIn.social({
				provider: 'google',
				idToken: { token: idToken, nonce },
			});
			if (error) throw new Error(error.message ?? error.statusText);
			if (!data || !('token' in data) || !('user' in data)) {
				throw new Error('Unexpected response from server');
			}

			return await resolveSessionWithToken(getIssuedToken(data));
		},
	};
}

function toStoredUser(user: User): StoredUser {
	return {
		id: user.id,
		createdAt: toISOString(user.createdAt),
		updatedAt: toISOString(user.updatedAt),
		email: user.email,
		emailVerified: user.emailVerified,
		name: user.name,
		image: user.image,
	};
}

function getErrorStatus(error: unknown): number | undefined {
	if (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
	) {
		return error.status;
	}

	return undefined;
}

function readAuthToken(value: unknown): string | null {
	if (
		typeof value === 'object' &&
		value !== null &&
		'session' in value &&
		typeof value.session === 'object' &&
		value.session !== null &&
		'token' in value.session &&
		typeof value.session.token === 'string'
	) {
		return value.session.token;
	}

	if (
		typeof value === 'object' &&
		value !== null &&
		'token' in value &&
		typeof value.token === 'string'
	) {
		return value.token;
	}

	return null;
}

function readEpicenterUserKeyBase64(
	data: GetSessionData,
): string | null | undefined {
	return (data as EpicenterSessionData).encryptionKey;
}

function toISOString(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : value;
}

function resolveBaseURL(baseURL: BaseURL): string {
	return typeof baseURL === 'function' ? baseURL() : baseURL;
}
