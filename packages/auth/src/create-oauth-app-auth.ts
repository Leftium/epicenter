import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { BEARER_SUBPROTOCOL_PREFIX } from '@epicenter/constants/auth';
import { subjectKeyringsEqual } from '@epicenter/encryption';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import type { AuthClient, AuthState } from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import {
	ApiSessionResponse,
	type OAuthTokenGrant,
	type PersistedAuth as PersistedAuthType,
} from './auth-types.js';
import { parseOAuthTokenGrant } from './oauth-token-response.js';

/**
 * Storage adapter for the single `PersistedAuth` cell (grant + localIdentity).
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

type AuthFetchInput = Request | string | URL;

export type AuthFetch = (
	input: AuthFetchInput,
	init?: RequestInit,
) => Promise<Response>;

export type CreateOAuthAppAuthConfig = {
	baseURL?: string;
	clientId: string;
	persistedAuthStorage: PersistedAuthStorage;
	launcher: OAuthSignInLauncher;
	fetch?: AuthFetch;
	WebSocket?: typeof WebSocket;
	now?: () => number;
	log?: Logger;
};

const REFRESH_SKEW_MS = 60_000;

const AuthStateChangeError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Auth state subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

type NetworkAccess = 'unverified' | 'verified' | 'paused';

type RuntimeAuthState =
	| { status: 'signed-out' }
	| {
			status: 'signed-in';
			cell: PersistedAuthType;
			networkAccess: NetworkAccess;
	  };

type RefreshFlight = {
	cell: PersistedAuthType;
	promise: Promise<boolean>;
};

type IdentityVerificationFlight = {
	cell: PersistedAuthType;
	promise: Promise<Result<ApiSessionResponse, AuthError>>;
};

/**
 * Create the app-side auth boundary for browser, extension, and machine clients.
 *
 * Use this once per runtime around a single persisted auth cell. The returned
 * client exposes capabilities (`fetch`, `openWebSocket`) instead of raw tokens:
 * it refreshes grants, verifies `/api/session` before attaching a bearer, and
 * keeps `localIdentity` available when network auth pauses. That preserves the
 * local-first invariant: offline workspace boot can continue, but server access
 * fails closed until the current cell has been verified by the API.
 */
export function createOAuthAppAuth({
	baseURL = EPICENTER_API_URL,
	clientId,
	persistedAuthStorage,
	launcher,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	WebSocket: WebSocketImpl = globalThis.WebSocket,
	now = Date.now,
	log = createLogger('auth/oauth-app'),
}: CreateOAuthAppAuthConfig): AuthClient {
	let runtimeState = runtimeStateFromPersistedAuth(persistedAuthStorage.get());
	let refreshFlight: RefreshFlight | null = null;
	let identityVerificationFlight: IdentityVerificationFlight | null = null;
	let storageWriteQueue: Promise<void> = Promise.resolve();

	let state = publicStateFromRuntime(runtimeState);
	const stateChangeListeners = new Set<(state: AuthState) => void>();

	function currentCell(): PersistedAuthType | null {
		return runtimeState.status === 'signed-out' ? null : runtimeState.cell;
	}

	function isNetworkAuthPaused() {
		return (
			runtimeState.status === 'signed-in' &&
			runtimeState.networkAccess === 'paused'
		);
	}

	function verifiedNetworkCell(): PersistedAuthType | null {
		if (runtimeState.status === 'signed-out') return null;
		if (runtimeState.networkAccess !== 'verified') return null;
		return runtimeState.cell;
	}

	function publishState() {
		const next = publicStateFromRuntime(runtimeState);
		if (authStatesEqual(state, next)) return;
		state = next;
		for (const listener of stateChangeListeners) {
			try {
				listener(next);
			} catch (error) {
				log.error(AuthStateChangeError.SubscriberThrew({ cause: error }));
			}
		}
	}

	function transitionToSignedOut() {
		runtimeState = { status: 'signed-out' };
		refreshFlight = null;
		identityVerificationFlight = null;
		publishState();
	}

	function replaceWithUnverifiedCell(cell: PersistedAuthType) {
		runtimeState = {
			status: 'signed-in',
			cell,
			networkAccess: 'unverified',
		};
		publishState();
	}

	function replaceWithVerifiedCell(cell: PersistedAuthType) {
		runtimeState = {
			status: 'signed-in',
			cell,
			networkAccess: 'verified',
		};
		publishState();
	}

	function pauseNetworkAuth() {
		if (runtimeState.status === 'signed-out') return;
		runtimeState = {
			...runtimeState,
			networkAccess: 'paused',
		};
		publishState();
	}

	async function writePersistedAuth(value: PersistedAuthType | null) {
		const write = storageWriteQueue.then(() => persistedAuthStorage.set(value));
		storageWriteQueue = write.catch(() => undefined);
		await write;
	}

	async function clearPersistedAuth() {
		transitionToSignedOut();
		await writePersistedAuth(null);
	}

	async function refreshGrant(force: boolean): Promise<boolean> {
		const startedFrom = currentCell();
		if (startedFrom === null || isNetworkAuthPaused()) return false;
		if (
			!force &&
			startedFrom.grant.accessTokenExpiresAt > now() + REFRESH_SKEW_MS
		) {
			return true;
		}
		if (refreshFlight?.cell === startedFrom) return refreshFlight.promise;

		const promise = (async () => {
			try {
				const grant = await refreshOAuthTokenWithEndpoint({
					baseURL,
					clientId,
					grant: startedFrom.grant,
					fetch: fetchImpl,
					now,
				});
				if (currentCell() !== startedFrom) return false;
				const next: PersistedAuthType = {
					grant,
					localIdentity: startedFrom.localIdentity,
				};
				await writePersistedAuth(next);
				if (currentCell() !== startedFrom) return false;
				replaceWithUnverifiedCell(next);
				return true;
			} catch (cause) {
				if (currentCell() === startedFrom) {
					pauseNetworkAuth();
					log.error(AuthError.RefreshGrantFailed({ cause }));
				}
				return false;
			} finally {
				if (refreshFlight?.cell === startedFrom) refreshFlight = null;
			}
		})();
		refreshFlight = { cell: startedFrom, promise };

		return promise;
	}

	async function callApiSession(
		grant: OAuthTokenGrant,
	): Promise<Result<ApiSessionResponse, AuthError>> {
		let response: Response;
		try {
			response = await fetchImpl(`${baseURL}/api/session`, {
				headers: { Authorization: `Bearer ${grant.accessToken}` },
				credentials: 'omit',
			});
		} catch (cause) {
			return AuthError.VerifyIdentityFailed({ cause });
		}
		if (!response.ok) {
			return AuthError.VerifyIdentityFailed({
				cause: new Error(`/api/session failed with ${response.status}.`),
			});
		}
		try {
			return Ok(ApiSessionResponse.assert(await response.json()));
		} catch (cause) {
			return AuthError.VerifyIdentityFailed({ cause });
		}
	}

	/**
	 * Verify `/api/session` against the persisted cell. Marks the cell verified;
	 * writes the localIdentity cell only when the keyring actually changed.
	 * Wipes the cell on same-subject-guard mismatch. Single-flight: concurrent
	 * callers share the in-flight promise.
	 */
	async function verifyCurrentCell(
		startedFrom: PersistedAuthType,
	): Promise<Result<ApiSessionResponse, AuthError>> {
		if (identityVerificationFlight?.cell === startedFrom) {
			return identityVerificationFlight.promise;
		}
		const promise = (async (): Promise<
			Result<ApiSessionResponse, AuthError>
		> => {
			const { data: session, error } = await callApiSession(startedFrom.grant);
			if (error) return AuthError.VerifyIdentityFailed({ cause: error });
			const current = currentCell();
			if (current !== startedFrom) return Ok(session);

			if (current.localIdentity.subject !== session.localIdentity.subject) {
				await clearPersistedAuth();
				return Ok(session);
			}

			if (
				!subjectKeyringsEqual(
					current.localIdentity.keyring,
					session.localIdentity.keyring,
				)
			) {
				const next: PersistedAuthType = {
					grant: current.grant,
					localIdentity: session.localIdentity,
				};
				await writePersistedAuth(next);
				if (currentCell() !== startedFrom) return Ok(session);
				replaceWithVerifiedCell(next);
				return Ok(session);
			}
			replaceWithVerifiedCell(current);
			return Ok(session);
		})().finally(() => {
			if (identityVerificationFlight?.cell === startedFrom) {
				identityVerificationFlight = null;
			}
		});
		identityVerificationFlight = { cell: startedFrom, promise };

		return promise;
	}

	/**
	 * Network gate. Returns the access token to attach to a bearer-bearing
	 * request, or `null` if no bearer should be attached.
	 *
	 * Refuses to attach unless `/api/session` has confirmed the current cell in
	 * this runtime. Cold boot online: refresh grant if
	 * stale, call `/api/session`, then attach. Offline: fails closed; local
	 * workspace decrypt continues via `localIdentity`.
	 */
	async function bearerForNetwork(force: boolean): Promise<string | null> {
		if (currentCell() === null || isNetworkAuthPaused()) return null;
		const refreshed = await refreshGrant(force);
		const refreshedCell = currentCell();
		if (!refreshed || refreshedCell === null || isNetworkAuthPaused()) {
			return null;
		}
		let verifiedCell = verifiedNetworkCell();
		if (verifiedCell === null) {
			await verifyCurrentCell(refreshedCell);
			verifiedCell = verifiedNetworkCell();
			if (verifiedCell === null) return null;
		}
		return verifiedCell.grant.accessToken;
	}

	async function fetchWithAuth(
		input: AuthFetchInput,
		init: RequestInit | undefined,
		forceRefresh: boolean,
	) {
		const headers = headersFromRequest(input, init);
		const accessToken = await bearerForNetwork(forceRefresh);
		if (accessToken) {
			headers.set('Authorization', `Bearer ${accessToken}`);
		} else {
			headers.delete('Authorization');
		}
		let normalizedInput: AuthFetchInput = input;
		if (input instanceof Request) {
			normalizedInput = input.clone() as Request;
		} else if (typeof input === 'string' && input.startsWith('/')) {
			normalizedInput = new URL(input, baseURL).toString();
		}
		return fetchImpl(normalizedInput, {
			...init,
			headers,
			credentials: 'omit',
		});
	}

	async function completeSignInWithGrant(
		grant: OAuthTokenGrant,
	): Promise<Result<undefined, AuthError>> {
		const previous = currentCell();
		const callResult = await callApiSession(grant);
		if (callResult.error) {
			return AuthError.StartSignInFailed({ cause: callResult.error });
		}
		const session = callResult.data;
		if (
			previous !== null &&
			previous.localIdentity.subject !== session.localIdentity.subject
		) {
			await clearPersistedAuth();
		}
		const next: PersistedAuthType = {
			grant,
			localIdentity: session.localIdentity,
		};
		await writePersistedAuth(next);
		replaceWithVerifiedCell(next);
		return Ok(undefined);
	}

	return {
		get state() {
			return state;
		},
		onStateChange(fn) {
			stateChangeListeners.add(fn);
			return () => {
				stateChangeListeners.delete(fn);
			};
		},
		async startSignIn() {
			try {
				const result = await launcher.startSignIn();
				if (result.error) {
					return AuthError.StartSignInFailed({ cause: result.error });
				}
				if (result.data === null) return Ok(undefined);
				return completeSignInWithGrant(result.data);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			}
		},
		async signOut() {
			try {
				const refreshTokenToRevoke = currentCell()?.grant.refreshToken;
				await clearPersistedAuth();
				if (refreshTokenToRevoke) {
					void revokeOAuthRefreshTokenWithEndpoint({
						baseURL,
						clientId,
						refreshToken: refreshTokenToRevoke,
						fetch: fetchImpl,
					}).catch(() => undefined);
				}
				return Ok(undefined);
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
		},
		async fetch(input, init?: RequestInit) {
			const response = await fetchWithAuth(input, init, false);
			if (response.status !== 401) return response;
			const refreshed = await refreshGrant(true);
			if (!refreshed) return response;
			const retryResponse = await fetchWithAuth(input, init, false);
			if (retryResponse.status === 401) {
				pauseNetworkAuth();
			}
			return retryResponse;
		},
		async openWebSocket(url, protocols = []) {
			const accessToken = await bearerForNetwork(false);
			const authProtocols = accessToken
				? [...protocols, `${BEARER_SUBPROTOCOL_PREFIX}${accessToken}`]
				: protocols;
			return new WebSocketImpl(String(url), authProtocols);
		},
		[Symbol.dispose]() {
			stateChangeListeners.clear();
		},
	};
}

function runtimeStateFromPersistedAuth(
	cell: PersistedAuthType | null,
): RuntimeAuthState {
	if (cell === null) return { status: 'signed-out' };
	return {
		status: 'signed-in',
		cell,
		networkAccess: 'unverified',
	};
}

function publicStateFromRuntime(runtimeState: RuntimeAuthState): AuthState {
	if (runtimeState.status === 'signed-out') return { status: 'signed-out' };
	if (runtimeState.networkAccess === 'paused') {
		return {
			status: 'reauth-required',
			localIdentity: runtimeState.cell.localIdentity,
		};
	}
	return {
		status: 'signed-in',
		localIdentity: runtimeState.cell.localIdentity,
	};
}

function authStatesEqual(left: AuthState, right: AuthState) {
	if (left.status !== right.status) return false;
	if (left.status === 'signed-out') return true;
	if (right.status === 'signed-out') return false;
	return (
		left.localIdentity.subject === right.localIdentity.subject &&
		subjectKeyringsEqual(
			left.localIdentity.keyring,
			right.localIdentity.keyring,
		)
	);
}

function headersFromRequest(input: Request | string | URL, init?: RequestInit) {
	const headers = new Headers(
		input instanceof Request ? input.headers : undefined,
	);
	copyHeaders(headers, init?.headers);
	return headers;
}

function copyHeaders(target: Headers, source: RequestInit['headers']) {
	if (!source) return;

	if (source instanceof Headers) {
		source.forEach((value, key) => target.set(key, value));
		return;
	}

	const value = source as unknown;

	if (Array.isArray(value)) {
		for (const [key, headerValue] of value) {
			setHeaderValue(target, key, headerValue);
		}
		return;
	}

	if (isHeaderIterable(value)) {
		for (const [key, headerValue] of value) {
			setHeaderValue(target, key, headerValue);
		}
		return;
	}

	for (const [key, headerValue] of Object.entries(
		value as Record<string, string | readonly string[] | undefined>,
	)) {
		setHeaderValue(target, key, headerValue);
	}
}

function setHeaderValue(
	target: Headers,
	key: string,
	value: string | readonly string[] | undefined,
) {
	if (value === undefined) return;
	if (typeof value === 'string') {
		target.set(key, value);
		return;
	}
	for (const item of value) target.append(key, item);
}

function isHeaderIterable(
	value: unknown,
): value is Iterable<readonly [string, string]> {
	return (
		value !== null && typeof value === 'object' && Symbol.iterator in value
	);
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
	fetch: AuthFetch;
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
	return parseOAuthTokenGrant(data, {
		now,
		fallbackRefreshToken: grant.refreshToken,
	});
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
	fetch: AuthFetch;
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
