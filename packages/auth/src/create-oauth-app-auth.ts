import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { Ok, type Result } from 'wellcrafted/result';
import type { AuthClient } from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import {
	authStateFromIdentity,
	createAuthStateStore,
} from './auth-state-store.js';
import type { AuthIdentity, OAuthSession } from './auth-types.js';
import { authIdentityFromAuthSessionResponse } from './contracts/auth-session.js';
import { headersFromRequest } from './request-headers.js';

export type OAuthSessionStorage = {
	get(): OAuthSession | null;
	set(value: OAuthSession | null): void | Promise<void>;
};

export type OAuthSignInLauncher = {
	startSignIn(input?: {
		returnTo?: string;
	}): Promise<Result<OAuthTokenResult | null, unknown>>;
};

export type OAuthTokenResult = {
	accessToken: string;
	refreshToken: string;
	accessTokenExpiresAt: number;
	scope: string | null;
	tokenType: string;
};

export type OAuthTokenRefresher = (input: {
	baseURL: string;
	clientId: string;
	session: OAuthSession;
	fetch: typeof fetch;
}) => Promise<OAuthTokenResult>;

export type CreateOAuthAppAuthConfig = {
	baseURL?: string;
	clientId: string;
	sessionStorage: OAuthSessionStorage;
	launcher: OAuthSignInLauncher;
	fetch?: typeof fetch;
	WebSocket?: typeof WebSocket;
	refreshOAuthToken?: OAuthTokenRefresher;
	now?: () => number;
};

const REFRESH_SKEW_MS = 60_000;
const BEARER_SUBPROTOCOL_PREFIX = 'bearer.';

export function createOAuthAppAuth({
	baseURL = EPICENTER_API_URL,
	clientId,
	sessionStorage,
	launcher,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	WebSocket: WebSocketImpl = globalThis.WebSocket,
	refreshOAuthToken = refreshOAuthTokenWithEndpoint,
	now = Date.now,
}: CreateOAuthAppAuthConfig): AuthClient {
	let session = sessionStorage.get();
	let networkAuthPaused = false;
	let hasDisposed = false;
	let refreshPromise: Promise<boolean> | null = null;

	const stateStore = createAuthStateStore(
		stateFromSession(session, {
			networkAuthPaused,
			now: now(),
		}),
	);

	async function setSession(next: OAuthSession | null) {
		await sessionStorage.set(next);
		session = next;
		stateStore.setState(
			stateFromSession(session, {
				networkAuthPaused,
				now: now(),
			}),
		);
	}

	async function applySignedInSession(next: OAuthSession) {
		networkAuthPaused = false;
		await setSession(next);
	}

	async function clearSession() {
		networkAuthPaused = false;
		await setSession(null);
	}

	async function loadIdentity(tokens: OAuthTokenResult): Promise<OAuthSession> {
		const response = await fetchImpl(`${baseURL}/auth/me`, {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
			credentials: 'omit',
		});
		if (!response.ok) {
			throw new Error(`/auth/me failed with ${response.status}.`);
		}
		const identity = authIdentityFromAuthSessionResponse(await response.json());
		if (identity === null) {
			throw new Error('/auth/me returned a signed-out identity.');
		}
		return {
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			accessTokenExpiresAt: tokens.accessTokenExpiresAt,
			user: identity.user,
			encryptionKeys: identity.encryptionKeys,
		} satisfies OAuthSession;
	}

	async function refreshSession({ force }: { force: boolean }) {
		if (session === null || networkAuthPaused) return false;
		if (!force && !shouldRefresh(session, now())) return true;
		if (refreshPromise) return refreshPromise;

		refreshPromise = (async () => {
			const current = session;
			if (current === null) return false;
			try {
				const tokens = await refreshOAuthToken({
					baseURL,
					clientId,
					session: current,
					fetch: fetchImpl,
				});
				const next = {
					...current,
					accessToken: tokens.accessToken,
					refreshToken: tokens.refreshToken,
					accessTokenExpiresAt: tokens.accessTokenExpiresAt,
				} satisfies OAuthSession;
				await applySignedInSession(next);
				return true;
			} catch (cause) {
				networkAuthPaused = true;
				stateStore.setState(
					stateFromSession(session, {
						networkAuthPaused,
						now: now(),
					}),
				);
				console.error('[auth] failed to refresh OAuth session:', cause);
				return false;
			} finally {
				refreshPromise = null;
			}
		})();

		return refreshPromise;
	}

	async function accessTokenForNetwork({ force }: { force: boolean }) {
		const refreshed = await refreshSession({ force });
		if (!refreshed || session === null || networkAuthPaused) return null;
		return session.accessToken;
	}

	async function fetchWithAuth(
		input: Request | string | URL,
		init: RequestInit | undefined,
		{ forceRefresh }: { forceRefresh: boolean },
	) {
		const headers = headersFromRequest(input, init);
		const accessToken = await accessTokenForNetwork({ force: forceRefresh });
		if (accessToken) {
			headers.set('Authorization', `Bearer ${accessToken}`);
		} else {
			headers.delete('Authorization');
		}
		return fetchImpl(input, { ...init, headers, credentials: 'omit' });
	}

	return {
		get state() {
			return stateStore.state;
		},
		onStateChange: stateStore.onStateChange,
		async startSignIn(input) {
			try {
				const result = await launcher.startSignIn(input);
				if (result.error) {
					return AuthError.StartSignInFailed({ cause: result.error });
				}
				if (result.data === null) return Ok(undefined);
				await applySignedInSession(await loadIdentity(result.data));
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			}
		},
		async signOut() {
			try {
				await clearSession();
				return Ok(undefined);
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
		},
		async fetch(input, init) {
			const response = await fetchWithAuth(input, init, {
				forceRefresh: false,
			});
			if (response.status !== 401) return response;
			const refreshed = await refreshSession({ force: true });
			if (!refreshed) return response;
			return fetchWithAuth(input, init, { forceRefresh: false });
		},
		async openWebSocket(url, protocols = []) {
			const accessToken = await accessTokenForNetwork({ force: false });
			const authProtocols = accessToken
				? [...protocols, `${BEARER_SUBPROTOCOL_PREFIX}${accessToken}`]
				: protocols;
			return new WebSocketImpl(String(url), authProtocols);
		},
		[Symbol.dispose]() {
			if (hasDisposed) return;
			hasDisposed = true;
			stateStore.clearListeners();
		},
	};
}

function stateFromSession(
	session: OAuthSession | null,
	{
		networkAuthPaused,
		now,
	}: {
		networkAuthPaused: boolean;
		now: number;
	},
) {
	if (session === null) return { status: 'signed-out' as const };
	const identity = identityFromSession(session);
	if (networkAuthPaused || tokenExpired(session, now)) {
		return { status: 'reauth-required' as const, identity };
	}
	return authStateFromIdentity(identity);
}

function identityFromSession(value: OAuthSession): AuthIdentity {
	return {
		user: value.user,
		encryptionKeys: value.encryptionKeys,
	};
}

function shouldRefresh(session: OAuthSession, now: number) {
	return session.accessTokenExpiresAt <= now + REFRESH_SKEW_MS;
}

function tokenExpired(session: OAuthSession, now: number) {
	return session.accessTokenExpiresAt <= now;
}

async function refreshOAuthTokenWithEndpoint({
	baseURL,
	clientId,
	session,
	fetch,
}: {
	baseURL: string;
	clientId: string;
	session: OAuthSession;
	fetch: typeof globalThis.fetch;
}): Promise<OAuthTokenResult> {
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: session.refreshToken,
		client_id: clientId,
		resource: baseURL,
	});
	const response = await fetch(`${baseURL}/auth/oauth2/token`, {
		method: 'POST',
		body,
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
		},
		credentials: 'omit',
	});
	if (!response.ok) {
		throw new Error(`OAuth refresh failed with ${response.status}.`);
	}
	const data = await response.json();
	return {
		accessToken: readString(data, 'access_token'),
		refreshToken:
			readOptionalString(data, 'refresh_token') ?? session.refreshToken,
		accessTokenExpiresAt:
			Date.now() + readPositiveNumber(data, 'expires_in') * 1000,
		scope: readOptionalString(data, 'scope'),
		tokenType: readString(data, 'token_type'),
	} satisfies OAuthTokenResult;
}

function readRecord(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Expected OAuth token response to be an object.');
	}
	return value as Record<string, unknown>;
}

function readString(value: unknown, key: string) {
	const record = readRecord(value);
	const field = record[key];
	if (typeof field !== 'string') {
		throw new Error(`Expected ${key} to be a string.`);
	}
	return field;
}

function readOptionalString(value: unknown, key: string) {
	const record = readRecord(value);
	const field = record[key];
	if (field === undefined || field === null) return null;
	if (typeof field !== 'string') {
		throw new Error(`Expected ${key} to be a string.`);
	}
	return field;
}

function readPositiveNumber(value: unknown, key: string) {
	const record = readRecord(value);
	const field = record[key];
	if (typeof field !== 'number' || !Number.isFinite(field) || field <= 0) {
		throw new Error(`Expected ${key} to be a positive number.`);
	}
	return field;
}
