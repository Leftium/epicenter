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

export type GoogleSignInResult =
	| SessionResolution
	| { status: 'redirect-started' };

export type ResolveSession = (
	current: AuthSession,
) => Promise<SessionResolution>;

export type BetterAuthTransportClient = ReturnType<typeof createAuthClient>;

export function createBetterAuthClientSession({
	baseURL,
	authToken,
}: {
	baseURL: BaseURL;
	authToken: string | null;
}) {
	let issuedToken: string | null | undefined;

	const client = createAuthClient({
		baseURL: resolveBaseURL(baseURL),
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

export async function resolveSessionWithToken({
	baseURL,
	authToken,
}: {
	baseURL: BaseURL;
	authToken: string | null;
}): Promise<SessionResolution> {
	const { client, getIssuedToken } = createBetterAuthClientSession({
		baseURL,
		authToken,
	});
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

export function createSessionResolver({
	baseURL,
}: {
	baseURL: BaseURL;
}): ResolveSession {
	return (current) =>
		resolveSessionWithToken({
			baseURL,
			authToken: current.status === 'authenticated' ? current.token : null,
		});
}

export async function signInWithPassword({
	baseURL,
	input,
}: {
	baseURL: BaseURL;
	input: { email: string; password: string };
}): Promise<SessionResolution> {
	const { client, getIssuedToken } = createBetterAuthClientSession({
		baseURL,
		authToken: null,
	});
	const { data, error } = await client.signIn.email(input);
	if (error) {
		throw error;
	}

	return await resolveSessionWithToken({
		baseURL,
		authToken: getIssuedToken(data),
	});
}

export async function signUpWithPassword({
	baseURL,
	input,
}: {
	baseURL: BaseURL;
	input: {
		email: string;
		password: string;
		name: string;
	};
}): Promise<SessionResolution> {
	const { client, getIssuedToken } = createBetterAuthClientSession({
		baseURL,
		authToken: null,
	});
	const { data, error } = await client.signUp.email(input);
	if (error) {
		throw error;
	}

	return await resolveSessionWithToken({
		baseURL,
		authToken: getIssuedToken(data),
	});
}

export async function signOutRemote({
	baseURL,
	current,
}: {
	baseURL: BaseURL;
	current: AuthSession;
}): Promise<void> {
	const { client } = createBetterAuthClientSession({
		baseURL,
		authToken: current.status === 'authenticated' ? current.token : null,
	});
	const { error } = await client.signOut();
	if (error) {
		throw error;
	}
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
	if (typeof value === 'object' && value !== null && 'encryptionKey' in value) {
		return typeof value.encryptionKey === 'string' ? value.encryptionKey : null;
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

function resolveBaseURL(baseURL: BaseURL): string {
	return typeof baseURL === 'function' ? baseURL() : baseURL;
}
