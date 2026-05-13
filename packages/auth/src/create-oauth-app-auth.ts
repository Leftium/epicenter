import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { Ok, type Result } from 'wellcrafted/result';
import type { AuthClient } from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import {
	authStateFromIdentity,
	createAuthStateStore,
} from './auth-state-store.js';
import {
	OAuthSession,
	type OAuthSession as OAuthSessionType,
	type OAuthTokenGrant,
	WorkspaceIdentity,
} from './auth-types.js';
import { headersFromRequest } from './request-headers.js';

export type OAuthSessionStorage = {
	get(): OAuthSessionType | null;
	set(value: OAuthSessionType | null): void | Promise<void>;
};

export type OAuthSignInLauncher = {
	startSignIn(): Promise<Result<OAuthTokenGrant | null, unknown>>;
};

export type OAuthTokenRefresher = (input: {
	baseURL: string;
	clientId: string;
	session: OAuthSessionType;
	fetch: typeof fetch;
	now: () => number;
}) => Promise<OAuthTokenGrant>;

export type OAuthRefreshTokenRevoker = (input: {
	baseURL: string;
	clientId: string;
	refreshToken: string;
	fetch: typeof fetch;
}) => Promise<void>;

export type CreateOAuthAppAuthConfig = {
	baseURL?: string;
	clientId: string;
	sessionStorage: OAuthSessionStorage;
	launcher: OAuthSignInLauncher;
	fetch?: typeof fetch;
	WebSocket?: typeof WebSocket;
	refreshOAuthToken?: OAuthTokenRefresher;
	revokeOAuthRefreshToken?: OAuthRefreshTokenRevoker;
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
	revokeOAuthRefreshToken = revokeOAuthRefreshTokenWithEndpoint,
	now = Date.now,
}: CreateOAuthAppAuthConfig) {
	let session = sessionStorage.get();
	let networkAuthPaused = false;
	let hasDisposed = false;
	let refreshPromise: Promise<boolean> | null = null;
	let sessionEpoch = 0;

	const stateStore = createAuthStateStore(
		stateFromSession(session, {
			networkAuthPaused,
		}),
	);

	function publishState() {
		stateStore.setState(
			stateFromSession(session, {
				networkAuthPaused,
			}),
		);
	}

	async function replaceSession(next: OAuthSessionType | null) {
		if (next && session && session.user.id !== next.user.id) {
			throw new Error(
				'[auth] replaceSession received an identity that does not match the ' +
					'current session. Sign out before signing in as a different user.',
			);
		}
		const writeEpoch = sessionEpoch + 1;
		sessionEpoch = writeEpoch;
		const staleRefresh = refreshPromise;
		if (staleRefresh) await staleRefresh.catch(() => false);
		await sessionStorage.set(next);
		if (writeEpoch !== sessionEpoch) return false;
		session = next;
		networkAuthPaused = false;
		publishState();
		return true;
	}

	async function loadIdentity(
		tokens: OAuthTokenGrant,
	): Promise<OAuthSessionType> {
		const response = await fetchImpl(`${baseURL}/workspace-identity`, {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
			credentials: 'omit',
		});
		if (!response.ok) {
			throw new Error(`/workspace-identity failed with ${response.status}.`);
		}
		const identity = WorkspaceIdentity.assert(await response.json());
		return OAuthSession.assert({
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			accessTokenExpiresAt: tokens.accessTokenExpiresAt,
			user: identity.user,
			encryptionKeys: identity.encryptionKeys,
		});
	}

	async function refreshSession({ force }: { force: boolean }) {
		if (session === null || networkAuthPaused) return false;
		if (!force && !shouldRefresh(session, now())) return true;
		if (refreshPromise) return refreshPromise;

		const startedAt = sessionEpoch;
		const current = session;
		refreshPromise = (async () => {
			if (current === null) return false;
			try {
				const tokens = await refreshOAuthToken({
					baseURL,
					clientId,
					session: current,
					fetch: fetchImpl,
					now,
				});
				if (startedAt !== sessionEpoch || session !== current) return false;
				const next = OAuthSession.assert({
					...current,
					accessToken: tokens.accessToken,
					refreshToken: tokens.refreshToken,
					accessTokenExpiresAt: tokens.accessTokenExpiresAt,
				});
				await sessionStorage.set(next);
				if (startedAt !== sessionEpoch || session !== current) return false;
				session = next;
				networkAuthPaused = false;
				publishState();
				return true;
			} catch (cause) {
				if (startedAt === sessionEpoch && session === current) {
					networkAuthPaused = true;
					publishState();
					console.error('[auth] failed to refresh OAuth session:', cause);
				}
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
		return fetchImpl(replayableInput(input), {
			...init,
			headers,
			credentials: 'omit',
		});
	}

	return {
		get state() {
			return stateStore.state;
		},
		onStateChange: stateStore.onStateChange,
		async startSignIn() {
			try {
				const result = await launcher.startSignIn();
				if (result.error) {
					return AuthError.StartSignInFailed({ cause: result.error });
				}
				if (result.data === null) return Ok(undefined);
				await replaceSession(await loadIdentity(result.data));
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			}
		},
		async signOut() {
			try {
				const sessionToRevoke = session;
				sessionEpoch += 1;
				if (sessionToRevoke !== null) {
					await revokeOAuthRefreshToken({
						baseURL,
						clientId,
						refreshToken: sessionToRevoke.refreshToken,
						fetch: fetchImpl,
					}).catch(() => undefined);
				}
				await replaceSession(null);
				return Ok(undefined);
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
		},
		async fetch(input, init?: RequestInit) {
			const response = await fetchWithAuth(input, init, {
				forceRefresh: false,
			});
			if (response.status !== 401) return response;
			const refreshed = await refreshSession({ force: true });
			if (!refreshed) return response;
			const retryResponse = await fetchWithAuth(input, init, {
				forceRefresh: false,
			});
			if (retryResponse.status === 401) {
				networkAuthPaused = true;
				publishState();
			}
			return retryResponse;
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
	} satisfies AuthClient;
}

function stateFromSession(
	session: OAuthSessionType | null,
	{
		networkAuthPaused,
	}: {
		networkAuthPaused: boolean;
	},
) {
	if (session === null) return { status: 'signed-out' as const };
	const { user, encryptionKeys } = session;
	const identity = { user, encryptionKeys };
	if (networkAuthPaused) {
		return { status: 'reauth-required' as const, identity };
	}
	return authStateFromIdentity(identity);
}

function shouldRefresh(session: OAuthSessionType, now: number) {
	return session.accessTokenExpiresAt <= now + REFRESH_SKEW_MS;
}

function replayableInput<TInput extends Request | string | URL>(input: TInput) {
	return (input instanceof Request ? input.clone() : input) as TInput;
}

async function refreshOAuthTokenWithEndpoint({
	baseURL,
	clientId,
	session,
	fetch,
	now,
}: {
	baseURL: string;
	clientId: string;
	session: OAuthSessionType;
	fetch: typeof globalThis.fetch;
	now: () => number;
}): Promise<OAuthTokenGrant> {
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
	const tokenType = readString(data, 'token_type');
	if (tokenType.toLowerCase() !== 'bearer') {
		throw new Error(`Expected token_type to be bearer, got ${tokenType}.`);
	}
	return {
		accessToken: readString(data, 'access_token'),
		refreshToken:
			readOptionalString(data, 'refresh_token') ?? session.refreshToken,
		accessTokenExpiresAt: now() + readPositiveNumber(data, 'expires_in') * 1000,
	} satisfies OAuthTokenGrant;
}

async function revokeOAuthRefreshTokenWithEndpoint({
	baseURL,
	clientId,
	refreshToken,
	fetch,
}: {
	baseURL: string;
	clientId: string;
	refreshToken: string;
	fetch: typeof globalThis.fetch;
}) {
	const body = new URLSearchParams({
		client_id: clientId,
		token: refreshToken,
		token_type_hint: 'refresh_token',
	});
	const response = await fetch(`${baseURL}/auth/oauth2/revoke`, {
		method: 'POST',
		body,
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
		},
		credentials: 'omit',
	});
	if (!response.ok) {
		throw new Error(`OAuth revoke failed with ${response.status}.`);
	}
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
