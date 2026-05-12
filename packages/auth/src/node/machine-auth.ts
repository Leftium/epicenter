import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { EPICENTER_CLI_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import { createAuthClient } from 'better-auth/client';
import { deviceAuthorizationClient } from 'better-auth/client/plugins';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AuthClient } from '../auth-contract.js';
import {
	WorkspaceIdentity,
	OAuthSession,
	type OAuthSession as OAuthSessionType,
} from '../auth-types.js';
import type {
	OAuthRefreshTokenRevoker,
	OAuthTokenRefresher,
} from '../create-oauth-app-auth.js';
import { createOAuthAppAuth } from '../create-oauth-app-auth.js';
import {
	loadMachineSession,
	saveMachineSession,
} from './machine-session-store.js';

const rawDefaultAuthClient = createAuthClient({
	baseURL: EPICENTER_API_URL,
	basePath: '/auth',
	plugins: [deviceAuthorizationClient()],
});

const defaultAuthClient =
	rawDefaultAuthClient as typeof rawDefaultAuthClient & {
		deviceCode: typeof rawDefaultAuthClient.device.code;
		deviceToken: typeof rawDefaultAuthClient.device.token;
	};

export type MachineAuthClient = typeof defaultAuthClient;

export const MachineAuthRequestError = defineErrors({
	RequestFailed: ({ cause }: { cause: unknown }) => ({
		message: `Auth transport request failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MachineAuthRequestError = InferErrors<
	typeof MachineAuthRequestError
>;

export const DeviceTokenError = defineErrors({
	DeviceCodeExpired: () => ({
		message: 'Device code expired. Run login again.',
	}),
	DeviceAccessDenied: () => ({
		message: 'Authorization denied.',
	}),
	DeviceAuthorizationFailed: ({
		code,
		description,
	}: {
		code: string;
		description?: string;
	}) => ({
		message: description ?? code,
		code,
		description,
	}),
});
export type DeviceTokenError = InferErrors<typeof DeviceTokenError>;

type MachineSessionSummary = {
	user: Pick<OAuthSessionType['user'], 'id' | 'email'>;
};

function sessionSummary(session: OAuthSessionType): MachineSessionSummary {
	return {
		user: {
			id: session.user.id,
			email: session.user.email,
		},
	};
}

/**
 * Start Better Auth device-code login and save the resulting session.
 */
export async function loginWithDeviceCode({
	authClient = defaultAuthClient,
	sleep = Bun.sleep,
	backend = Bun.secrets,
	onDeviceCode,
}: {
	authClient?: MachineAuthClient;
	sleep?: (ms: number) => Promise<void>;
	backend?: typeof Bun.secrets;
	onDeviceCode?: (device: {
		userCode: string;
		verificationUriComplete: string;
	}) => void | Promise<void>;
} = {}) {
	const { data: code, error: codeError } = await authClient.deviceCode({
		client_id: EPICENTER_CLI_OAUTH_CLIENT_ID,
	});
	if (codeError) {
		return MachineAuthRequestError.RequestFailed({ cause: codeError });
	}

	const device = {
		userCode: code.user_code,
		verificationUriComplete: code.verification_uri_complete,
	};
	await onDeviceCode?.(device);

	const { data: tokens, error: pollError } = await pollForAccessToken({
		authClient,
		deviceCode: code.device_code,
		intervalMs: code.interval * 1000,
		expiresInMs: code.expires_in * 1000,
		sleep,
	});
	if (pollError) return Err(pollError);

	const { data: session, error: fetchError } = await fetchOAuthSession({
		authClient,
		tokens,
	});
	if (fetchError) return Err(fetchError);

	const { error: saveError } = await saveMachineSession(session, {
		backend,
	});
	if (saveError) return Err(saveError);

	return Ok({
		status: 'loggedIn' as const,
		session: sessionSummary(session),
		device,
	});
}

/**
 * Read the saved session and verify it remotely when possible. Network
 * failures surface as `unverified`, not `Err`, so the CLI can show the cached
 * identity even when offline.
 */
export async function status({
	authClient = defaultAuthClient,
	backend = Bun.secrets,
	log = createLogger('machine-auth'),
}: {
	authClient?: MachineAuthClient;
	backend?: typeof Bun.secrets;
	log?: Logger;
} = {}) {
	const { data: session, error: loadError } = await loadMachineSession({
		backend,
		log,
	});
	if (loadError) return Err(loadError);
	if (session === null) return Ok({ status: 'signedOut' as const });

	const { data: remoteSession, error: fetchError } = await fetchOAuthSession({
		authClient,
		tokens: {
			accessToken: session.accessToken,
			refreshToken: session.refreshToken,
			accessTokenExpiresAt: session.accessTokenExpiresAt,
		},
	});
	if (fetchError) {
		return Ok({
			status: 'unverified' as const,
			session: sessionSummary(session),
			verificationError: fetchError,
		});
	}

	const { error: saveError } = await saveMachineSession(remoteSession, {
		backend,
	});
	if (saveError) return Err(saveError);
	return Ok({
		status: 'valid' as const,
		session: sessionSummary(remoteSession),
	});
}

export async function logout({
	authClient = defaultAuthClient,
	backend = Bun.secrets,
	log = createLogger('machine-auth'),
}: {
	authClient?: MachineAuthClient;
	backend?: typeof Bun.secrets;
	log?: Logger;
} = {}) {
	const { data: session, error: loadError } = await loadMachineSession({
		backend,
		log,
	});
	if (loadError) return Err(loadError);
	if (session === null) return Ok({ status: 'signedOut' as const });

	try {
		const { error: signOutError } = await authClient.signOut({
			fetchOptions: {
				headers: { Authorization: `Bearer ${session.accessToken}` },
			},
		});
		if (signOutError) {
			const wrappedError = MachineAuthRequestError.RequestFailed({
				cause: signOutError,
			}).error;
			if (wrappedError) log.warn(wrappedError);
		}
	} catch (cause) {
		const wrappedError = MachineAuthRequestError.RequestFailed({
			cause,
		}).error;
		if (wrappedError) log.warn(wrappedError);
	}

	const { error: saveError } = await saveMachineSession(null, { backend });
	if (saveError) return Err(saveError);
	return Ok({ status: 'loggedOut' as const });
}

async function pollForAccessToken({
	authClient,
	deviceCode,
	intervalMs,
	expiresInMs,
	sleep,
}: {
	authClient: MachineAuthClient;
	deviceCode: string;
	intervalMs: number;
	expiresInMs: number;
	sleep: (ms: number) => Promise<void>;
}): Promise<
	Result<
		Pick<
			OAuthSessionType,
			'accessToken' | 'refreshToken' | 'accessTokenExpiresAt'
		>,
		DeviceTokenError | MachineAuthRequestError
	>
> {
	const deadline = Date.now() + expiresInMs;
	let interval = intervalMs;
	while (Date.now() < deadline) {
		await sleep(interval);
		const { data, error } = await authClient.deviceToken({
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
			device_code: deviceCode,
			client_id: EPICENTER_CLI_OAUTH_CLIENT_ID,
		});
		if (data) {
			const tokenData = readRecord(data, 'device token response');
			return Ok({
				accessToken: readString(tokenData, 'access_token'),
				refreshToken: readString(tokenData, 'refresh_token'),
				accessTokenExpiresAt:
					Date.now() + readPositiveNumber(tokenData, 'expires_in') * 1000,
			});
		}
		if (!error) {
			return MachineAuthRequestError.RequestFailed({
				cause: new Error('device.token returned neither data nor error'),
			});
		}

		switch (error.error) {
			case 'authorization_pending':
				continue;
			case 'slow_down':
				interval += 5_000;
				continue;
			case 'expired_token':
				return DeviceTokenError.DeviceCodeExpired();
			case 'access_denied':
				return DeviceTokenError.DeviceAccessDenied();
			default:
				return DeviceTokenError.DeviceAuthorizationFailed({
					code: error.error,
					description: error.error_description,
				});
		}
	}
	return DeviceTokenError.DeviceCodeExpired();
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Expected ${label} to be an object.`);
	}
	return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string) {
	const value = record[key];
	if (typeof value !== 'string') {
		throw new Error(`Expected ${key} to be a string.`);
	}
	return value;
}

function readPositiveNumber(record: Record<string, unknown>, key: string) {
	const value = record[key];
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Expected ${key} to be a positive number.`);
	}
	return value;
}

async function fetchOAuthSession({
	authClient,
	tokens,
}: {
	authClient: MachineAuthClient;
	tokens: Pick<
		OAuthSessionType,
		'accessToken' | 'refreshToken' | 'accessTokenExpiresAt'
	>;
}): Promise<Result<OAuthSessionType, MachineAuthRequestError>> {
	const { data, error } = await authClient.getSession({
		fetchOptions: {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
		},
	});
	if (error) return MachineAuthRequestError.RequestFailed({ cause: error });
	if (data === null) {
		return MachineAuthRequestError.RequestFailed({
			cause: new Error('getSession returned null after device-code login'),
		});
	}

	try {
		const identity = WorkspaceIdentity.assert(data);
		return Ok(
			OAuthSession.assert({
				...tokens,
				user: identity.user,
				encryptionKeys: identity.encryptionKeys,
			}),
		);
	} catch (cause) {
		return MachineAuthRequestError.RequestFailed({ cause });
	}
}

/**
 * Create an auth client backed by saved machine auth.
 *
 * Storage failures are propagated; daemons should crash rather than silently
 * boot signed-out when the keychain is unreadable.
 */
export async function createMachineAuthClient({
	backend = Bun.secrets,
	fetch,
	log = createLogger('machine-auth'),
	now,
	refreshOAuthToken,
	revokeOAuthRefreshToken,
}: {
	backend?: typeof Bun.secrets;
	fetch?: typeof globalThis.fetch;
	log?: Logger;
	now?: () => number;
	refreshOAuthToken?: OAuthTokenRefresher;
	revokeOAuthRefreshToken?: OAuthRefreshTokenRevoker;
} = {}): Promise<AuthClient> {
	const { data: loadedSession, error } = await loadMachineSession({
		backend,
		log,
	});
	if (error) throw error;
	if (loadedSession === null) {
		throw new Error(
			'[machine-auth] no saved session in the system keychain. ' +
				'Run `epicenter auth login` first.',
		);
	}
	let currentSession: OAuthSessionType | null = loadedSession;
	return createOAuthAppAuth({
		baseURL: EPICENTER_API_URL,
		clientId: EPICENTER_CLI_OAUTH_CLIENT_ID,
		launcher: {
			startSignIn: async () => Ok(null),
		},
		sessionStorage: {
			get: () => currentSession,
			set: async (next) => {
				const { error: saveError } = await saveMachineSession(next, {
					backend,
				});
				if (saveError) {
					log.error(saveError);
					throw saveError;
				}
				currentSession = next;
			},
		},
		...(fetch ? { fetch } : {}),
		...(now ? { now } : {}),
		...(refreshOAuthToken ? { refreshOAuthToken } : {}),
		...(revokeOAuthRefreshToken ? { revokeOAuthRefreshToken } : {}),
	});
}
