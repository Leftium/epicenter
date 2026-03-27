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

export function createAuthTransport({
	baseURL,
}: {
	baseURL: BaseURL;
}) {
	function createClientSession(authToken: string | null) {
		let issuedToken: string | null | undefined;

		const client = createAuthClient({
			baseURL: typeof baseURL === 'function' ? baseURL() : baseURL,
			basePath: '/auth',
			fetchOptions: {
				auth: {
					type: 'Bearer',
					token: () => authToken ?? undefined,
				},
				onSuccess: ({ response }) => {
					const nextToken = response.headers.get('set-auth-token');
					if (nextToken) issuedToken = nextToken;
				},
			},
		});

		return {
			client,
			getIssuedToken: (payload?: unknown) =>
				issuedToken ??
				(typeof payload === 'object' &&
				payload !== null &&
				'token' in payload &&
				typeof payload.token === 'string'
					? payload.token
					: null) ??
				authToken ??
				null,
		};
	}

	async function resolveSessionWithToken(
		authToken: string | null,
	): Promise<SessionResolution> {
		const { client, getIssuedToken } = createClientSession(authToken);
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

		const token = getIssuedToken(data);
		if (!token) {
			throw new Error('Authenticated session is missing bearer token');
		}

		return {
			status: 'authenticated',
			token,
			user: toStoredUser(data.user),
			userKeyBase64:
				typeof data === 'object' && data !== null && 'encryptionKey' in data
					? typeof data.encryptionKey === 'string'
						? data.encryptionKey
						: null
					: undefined,
		};
	}

	return {
		resolveSession(current: AuthSession): Promise<SessionResolution> {
			return resolveSessionWithToken(
				current.status === 'authenticated' ? current.token : null,
			);
		},

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

		async signOutRemote(current: AuthSession): Promise<void> {
			const { client } = createClientSession(
				current.status === 'authenticated' ? current.token : null,
			);
			const { error } = await client.signOut();
			if (error) {
				throw error;
			}
		},

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
			if (!data || !('user' in data)) {
				throw new Error('Unexpected response from server');
			}

			return await resolveSessionWithToken(getIssuedToken(data));
		},
	};
}

function toStoredUser(user: User): StoredUser {
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
