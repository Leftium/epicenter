import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { EncryptionKeys, encryptionKeysEqual } from '@epicenter/encryption';
import { type } from 'arktype';
import { Ok, type Result } from 'wellcrafted/result';
import type { AuthClient, AuthState } from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import { createAuthStateStore } from './auth-state-store.js';
import {
	AuthUser,
	type OAuthTokenGrant,
	type PersistedAuth as PersistedAuthType,
} from './auth-types.js';
import { headersFromRequest } from './request-headers.js';

/**
 * Storage adapter for the single `PersistedAuth` cell (grant + unlock).
 * Two methods, no watch hook: cross-context sign-out propagates via the
 * server (next bearer-bearing call hits a revoked token and reauth-requires
 * organically). The server is the authority; brief cross-tab desync is
 * acceptable.
 */
export type PersistedAuthStorage = {
	get(): PersistedAuthType | null;
	set(value: PersistedAuthType | null): void | Promise<void>;
};

export type OAuthSignInLauncher = {
	startSignIn(): Promise<Result<OAuthTokenGrant | null, unknown>>;
};

export type OAuthTokenRefresher = (input: {
	baseURL: string;
	clientId: string;
	grant: OAuthTokenGrant;
	fetch: typeof fetch;
	now: () => number;
}) => Promise<OAuthTokenGrant>;

export type OAuthRefreshTokenRevoker = (input: {
	baseURL: string;
	clientId: string;
	refreshToken: string;
	fetch: typeof fetch;
}) => Promise<void>;

/**
 * Shape returned by `GET /api/me`. Internal; not exported as a top-level
 * domain type because identity is no longer one thing.
 */
const ApiMeResponse = type({
	'+': 'delete',
	user: AuthUser,
	encryptionKeys: EncryptionKeys,
});
type ApiMeResponse = typeof ApiMeResponse.infer;

export type CreateOAuthAppAuthConfig = {
	baseURL?: string;
	clientId: string;
	persistedAuthStorage: PersistedAuthStorage;
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
	persistedAuthStorage,
	launcher,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	WebSocket: WebSocketImpl = globalThis.WebSocket,
	refreshOAuthToken = refreshOAuthTokenWithEndpoint,
	revokeOAuthRefreshToken = revokeOAuthRefreshTokenWithEndpoint,
	now = Date.now,
}: CreateOAuthAppAuthConfig): AuthClient {
	let persisted = persistedAuthStorage.get();
	/**
	 * In-memory display label fetched from `/api/me`. `email !== null` is the
	 * single freshness predicate: it implies `/api/me` succeeded for the
	 * *current* `persisted` reference in this runtime. Every cell mutation
	 * (sign-in, sign-out, same-user-guard wipe) clears `email` back to `null`,
	 * forcing a fresh verification before the next bearer attachment.
	 */
	let email: string | null = null;
	let networkAuthPaused = false;
	let hasDisposed = false;
	let refreshPromise: Promise<boolean> | null = null;
	let profilePromise: Promise<Result<ApiMeResponse, AuthError>> | null = null;

	const stateStore = createAuthStateStore(deriveState());

	function deriveState(): AuthState {
		if (persisted === null) return { status: 'signed-out' };
		if (networkAuthPaused) {
			return {
				status: 'reauth-required',
				unlock: persisted.unlock,
				email,
			};
		}
		return {
			status: 'signed-in',
			unlock: persisted.unlock,
			email,
		};
	}

	function publishState() {
		stateStore.setState(deriveState());
	}

	async function refreshGrant({ force }: { force: boolean }): Promise<boolean> {
		if (persisted === null || networkAuthPaused) return false;
		if (!force && !shouldRefreshGrant(persisted.grant, now())) return true;
		if (refreshPromise) return refreshPromise;

		const startedFrom = persisted;
		refreshPromise = (async () => {
			try {
				const grant = await refreshOAuthToken({
					baseURL,
					clientId,
					grant: startedFrom.grant,
					fetch: fetchImpl,
					now,
				});
				if (persisted !== startedFrom) return false;
				const next: PersistedAuthType = {
					grant,
					unlock: startedFrom.unlock,
				};
				await persistedAuthStorage.set(next);
				if (persisted !== startedFrom) return false;
				persisted = next;
				networkAuthPaused = false;
				publishState();
				return true;
			} catch (cause) {
				if (persisted === startedFrom) {
					networkAuthPaused = true;
					publishState();
					console.error('[auth] failed to refresh OAuth grant:', cause);
				}
				return false;
			} finally {
				refreshPromise = null;
			}
		})();

		return refreshPromise;
	}

	async function callApiMe(
		grant: OAuthTokenGrant,
	): Promise<Result<ApiMeResponse, AuthError>> {
		let response: Response;
		try {
			response = await fetchImpl(`${baseURL}/api/me`, {
				headers: { Authorization: `Bearer ${grant.accessToken}` },
				credentials: 'omit',
			});
		} catch (cause) {
			return AuthError.FetchProfileFailed({ cause });
		}
		if (!response.ok) {
			return AuthError.FetchProfileFailed({
				cause: new Error(`/api/me failed with ${response.status}.`),
			});
		}
		try {
			return Ok(ApiMeResponse.assert(await response.json()));
		} catch (cause) {
			return AuthError.FetchProfileFailed({ cause });
		}
	}

	/**
	 * Verify `/api/me` against the persisted cell. Updates `email` in memory;
	 * writes the unlock cell only when `encryptionKeys` actually changed.
	 * Wipes the cell on same-user-guard mismatch. Single-flight: concurrent
	 * callers share the in-flight promise.
	 */
	async function verifyProfile(): Promise<Result<ApiMeResponse, AuthError>> {
		if (profilePromise) return profilePromise;
		if (persisted === null) {
			return AuthError.FetchProfileFailed({
				cause: new Error('No persisted cell; cannot verify profile.'),
			});
		}
		const startedFrom = persisted;
		profilePromise = (async (): Promise<Result<ApiMeResponse, AuthError>> => {
			const { data: apiMe, error } = await callApiMe(startedFrom.grant);
			if (error) return AuthError.FetchProfileFailed({ cause: error });
			if (persisted !== startedFrom) return Ok(apiMe);

			if (persisted.unlock.userId !== apiMe.user.id) {
				await persistedAuthStorage.set(null);
				persisted = null;
				email = null;
				networkAuthPaused = false;
				publishState();
				return Ok(apiMe);
			}

			if (
				!encryptionKeysEqual(
					persisted.unlock.encryptionKeys,
					apiMe.encryptionKeys,
				)
			) {
				const next: PersistedAuthType = {
					grant: persisted.grant,
					unlock: {
						userId: apiMe.user.id,
						encryptionKeys: apiMe.encryptionKeys,
					},
				};
				await persistedAuthStorage.set(next);
				if (persisted !== startedFrom) return Ok(apiMe);
				persisted = next;
			}
			email = apiMe.user.email;
			publishState();
			return Ok(apiMe);
		})().finally(() => {
			profilePromise = null;
		});

		return profilePromise;
	}

	/**
	 * Network gate. Returns the access token to attach to a bearer-bearing
	 * request, or `null` if no bearer should be attached.
	 *
	 * Refuses to attach unless `/api/me` has confirmed the current cell in
	 * this runtime (`email !== null`). Cold-boot online: refresh grant if
	 * stale, call `/api/me`, then attach. Offline: fails closed; local
	 * workspace decrypt continues via `unlock`.
	 */
	async function bearerForNetwork({
		force,
	}: {
		force: boolean;
	}): Promise<string | null> {
		if (persisted === null || networkAuthPaused) return null;
		const refreshed = await refreshGrant({ force });
		if (!refreshed || persisted === null || networkAuthPaused) return null;
		if (email === null) {
			await verifyProfile();
			if (persisted === null || networkAuthPaused || email === null) {
				return null;
			}
		}
		return persisted.grant.accessToken;
	}

	async function fetchWithAuth(
		input: Request | string | URL,
		init: RequestInit | undefined,
		{ forceRefresh }: { forceRefresh: boolean },
	) {
		const headers = headersFromRequest(input, init);
		const accessToken = await bearerForNetwork({ force: forceRefresh });
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

	async function applySignIn(
		grant: OAuthTokenGrant,
	): Promise<Result<undefined, AuthError>> {
		const callResult = await callApiMe(grant);
		if (callResult.error) {
			return AuthError.StartSignInFailed({ cause: callResult.error });
		}
		const apiMe = callResult.data;
		const next: PersistedAuthType = {
			grant,
			unlock: {
				userId: apiMe.user.id,
				encryptionKeys: apiMe.encryptionKeys,
			},
		};
		await persistedAuthStorage.set(next);
		persisted = next;
		email = apiMe.user.email;
		networkAuthPaused = false;
		publishState();
		return Ok(undefined);
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
				return applySignIn(result.data);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			}
		},
		async signOut() {
			try {
				const cellToRevoke = persisted;
				profilePromise = null;
				if (cellToRevoke !== null) {
					await revokeOAuthRefreshToken({
						baseURL,
						clientId,
						refreshToken: cellToRevoke.grant.refreshToken,
						fetch: fetchImpl,
					}).catch(() => undefined);
				}
				await persistedAuthStorage.set(null);
				persisted = null;
				email = null;
				networkAuthPaused = false;
				publishState();
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
			const refreshed = await refreshGrant({ force: true });
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
			const accessToken = await bearerForNetwork({ force: false });
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

function shouldRefreshGrant(grant: OAuthTokenGrant, now: number) {
	return grant.accessTokenExpiresAt <= now + REFRESH_SKEW_MS;
}

function replayableInput<TInput extends Request | string | URL>(input: TInput) {
	return (input instanceof Request ? input.clone() : input) as TInput;
}

async function refreshOAuthTokenWithEndpoint({
	baseURL,
	clientId,
	grant,
	fetch,
	now,
}: {
	baseURL: string;
	clientId: string;
	grant: OAuthTokenGrant;
	fetch: typeof globalThis.fetch;
	now: () => number;
}): Promise<OAuthTokenGrant> {
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: grant.refreshToken,
		client_id: clientId,
		resource: baseURL,
	});
	const response = await fetch(`${baseURL}/auth/oauth2/token`, {
		method: 'POST',
		body,
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
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
			readOptionalString(data, 'refresh_token') ?? grant.refreshToken,
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
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
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
