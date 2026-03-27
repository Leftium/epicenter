import type { User } from 'better-auth';
import { createAuthClient } from 'better-auth/client';
import type { AuthSession, StoredUser } from './auth-types.js';

export type RemoteAuthResult =
	| {
			status: 'authenticated';
			token: string;
			user: StoredUser;
			userKeyBase64?: string | null;
	  }
	| { status: 'anonymous' }
	| { status: 'unchanged' };

export type AuthTransport = {
	getSession(current: AuthSession): Promise<RemoteAuthResult>;
	signIn(input: { email: string; password: string }): Promise<RemoteAuthResult>;
	signUp(input: {
		email: string;
		password: string;
		name: string;
	}): Promise<RemoteAuthResult>;
	signInWithGoogle(): Promise<RemoteAuthResult>;
	signOut(current: AuthSession): Promise<void>;
};

export type BetterAuthTransportClient = ReturnType<typeof createAuthClient>;

export class AuthenticatedSessionLoadError extends Error {
	readonly operation: 'sign-in' | 'sign-up' | 'google-sign-in';

	constructor(operation: 'sign-in' | 'sign-up' | 'google-sign-in') {
		super(
			`${operation} completed but the authenticated session could not be loaded`,
		);
		this.name = 'AuthenticatedSessionLoadError';
		this.operation = operation;
	}
}

export function createAuthTransport({
	baseURL,
	signInWithGoogle,
}: {
	baseURL: string | (() => string);
	signInWithGoogle?: (
		client: BetterAuthTransportClient,
	) => Promise<unknown>;
}): AuthTransport {
	const resolveBaseUrl =
		typeof baseURL === 'function' ? baseURL : () => baseURL;

	function buildClient(authToken: string | null) {
		let issuedToken: string | null | undefined;

		const client = createAuthClient({
			baseURL: resolveBaseUrl(),
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
				issuedToken ?? readAuthToken(payload) ?? authToken ?? null,
		};
	}

	async function resolveSession(authToken: string | null): Promise<RemoteAuthResult> {
		const { client, getIssuedToken } = buildClient(authToken);
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
			userKeyBase64: readUserKeyBase64(data),
		};
	}

	async function resolveAuthenticatedSession(
		authToken: string | null,
		operation: 'sign-in' | 'sign-up' | 'google-sign-in',
	): Promise<RemoteAuthResult> {
		const result = await resolveSession(authToken);
		if (result.status !== 'authenticated') {
			throw new AuthenticatedSessionLoadError(operation);
		}

		return result;
	}

	return {
		getSession(current) {
			return resolveSession(
				current.status === 'authenticated' ? current.token : null,
			);
		},

		async signIn(input) {
			const { client, getIssuedToken } = buildClient(null);
			const { data, error } = await client.signIn.email(input);
			if (error) {
				throw error;
			}

			return await resolveAuthenticatedSession(getIssuedToken(data), 'sign-in');
		},

		async signUp(input) {
			const { client, getIssuedToken } = buildClient(null);
			const { data, error } = await client.signUp.email(input);
			if (error) {
				throw error;
			}

			return await resolveAuthenticatedSession(getIssuedToken(data), 'sign-up');
		},

		async signInWithGoogle() {
			const { client, getIssuedToken } = buildClient(null);

			if (signInWithGoogle) {
				await signInWithGoogle(client);
				const token = getIssuedToken();
				if (!token) return { status: 'unchanged' };
				return await resolveAuthenticatedSession(token, 'google-sign-in');
			}

			await client.signIn.social({
				provider: 'google',
				callbackURL: window.location.origin,
			});
			return { status: 'unchanged' };
		},

		async signOut(current) {
			const { client } = buildClient(
				current.status === 'authenticated' ? current.token : null,
			);
			const { error } = await client.signOut();
			if (error) {
				throw error;
			}
		},
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
		'token' in value &&
		typeof value.token === 'string'
	) {
		return value.token;
	}

	return null;
}

function readUserKeyBase64(value: unknown): string | null | undefined {
	if (
		typeof value === 'object' &&
		value !== null &&
		'encryptionKey' in value
	) {
		return typeof value.encryptionKey === 'string'
			? value.encryptionKey
			: null;
	}

	return undefined;
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

function toISOString(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : value;
}
