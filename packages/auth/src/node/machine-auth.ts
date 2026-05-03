import type { EncryptionKeys } from '@epicenter/encryption';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	AuthSession,
	type AuthSession as AuthSessionType,
} from '../auth-types.js';
import { type AuthClient, createAuth } from '../create-auth.js';
import type { SessionStorage } from '../session-store.js';
import {
	type AuthServerTransport,
	createAuthServerTransport,
} from './auth-server-transport.js';

export const MachineAuthError = defineErrors({
	AuthTransportRequestFailed: ({ cause }: { cause: unknown }) => ({
		message: `Auth transport request failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
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
	SessionStorageFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not read saved machine session: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MachineAuthError = InferErrors<typeof MachineAuthError>;

export type MachineAuthSessionStorage = {
	load(): Promise<AuthSessionType | null>;
	save(session: AuthSessionType | null): Promise<void>;
};

export type MachineAuthSessionStorageBackend = {
	get(options: { service: string; name: string }): Promise<string | null>;
	set(options: { service: string; name: string }, value: string): Promise<void>;
	delete(options: { service: string; name: string }): Promise<unknown>;
};

export type MachineSessionSummary = {
	user: Pick<AuthSessionType['user'], 'id' | 'name' | 'email'>;
};

export type MachineAuthLoginResult = {
	status: 'loggedIn';
	session: MachineSessionSummary;
	device: {
		userCode: string;
		verificationUriComplete: string;
	};
};

export type MachineAuthStatus =
	| { status: 'signedOut' }
	| { status: 'valid'; session: MachineSessionSummary }
	| {
			status: 'unverified';
			session: MachineSessionSummary;
			verificationError: MachineAuthError;
	  };

export type MachineAuthLogoutResult =
	| { status: 'signedOut' }
	| { status: 'loggedOut' };

export type MachineAuth = ReturnType<typeof createMachineAuth>;

type MachineAuthOptions = {
	fetch?: typeof globalThis.fetch;
	sessionStorage?: MachineAuthSessionStorage;
	clientId?: string;
	openBrowser?: (url: string) => Promise<void>;
	sleep?: (ms: number) => Promise<void>;
};

const MACHINE_SESSION_SERVICE = 'epicenter.auth.session';
const MACHINE_SESSION_ACCOUNT = 'current';
const EPICENTER_API_URL = 'https://api.epicenter.so';

function sessionSummary(session: AuthSessionType): MachineSessionSummary {
	return {
		user: {
			id: session.user.id,
			name: session.user.name,
			email: session.user.email,
		},
	};
}

function parseStoredSession(raw: string): AuthSessionType | null {
	try {
		return AuthSession.assert(JSON.parse(raw));
	} catch {
		return null;
	}
}

/**
 * Store one machine auth session in the operating system keychain.
 *
 * Machine auth persists the same `AuthSession` shape as browser auth. The
 * server remains the owner of expiry, provider details, and Better Auth session
 * metadata.
 */
export function createKeychainMachineAuthSessionStorage({
	backend = Bun.secrets,
}: {
	backend?: MachineAuthSessionStorageBackend;
} = {}): MachineAuthSessionStorage {
	const options = {
		service: MACHINE_SESSION_SERVICE,
		name: MACHINE_SESSION_ACCOUNT,
	};

	return {
		async load() {
			const raw = await backend.get(options);
			if (raw === null) return null;
			return parseStoredSession(raw);
		},
		async save(session) {
			if (session === null) {
				await backend.delete(options);
				return;
			}
			await backend.set(options, JSON.stringify(AuthSession.assert(session)));
		},
	};
}

/**
 * Create an in-memory machine auth store for tests and explicit embedding.
 */
export function createMemoryMachineAuthSessionStorage(
	initial: AuthSessionType | null = null,
): MachineAuthSessionStorage {
	let current = initial;
	return {
		async load() {
			return current;
		},
		async save(session) {
			current = session;
		},
	};
}

/**
 * Create the Node-side auth coordinator for CLI and daemon processes.
 */
export function createMachineAuth({
	fetch: fetchImpl = fetch,
	sessionStorage = createKeychainMachineAuthSessionStorage(),
	clientId = 'epicenter-cli',
	openBrowser,
	sleep = Bun.sleep,
}: MachineAuthOptions = {}) {
	const authTransport = createAuthServerTransport(
		{ fetch: fetchImpl },
		{ serverOrigin: EPICENTER_API_URL },
	);

	async function loadStoredSession(): Promise<
		Result<AuthSessionType | null, MachineAuthError>
	> {
		try {
			return Ok(await sessionStorage.load());
		} catch (cause) {
			return MachineAuthError.SessionStorageFailed({ cause });
		}
	}

	async function saveStoredSession(
		session: AuthSessionType | null,
	): Promise<Result<undefined, MachineAuthError>> {
		try {
			await sessionStorage.save(session);
			return Ok(undefined);
		} catch (cause) {
			return MachineAuthError.SessionStorageFailed({ cause });
		}
	}

	async function fetchSession({
		transport,
		token,
	}: {
		transport: AuthServerTransport;
		token: string;
	}) {
		try {
			return Ok(
				await transport.fetchSession({
					authorizationToken: token,
				}),
			);
		} catch (cause) {
			return MachineAuthError.AuthTransportRequestFailed({ cause });
		}
	}

	return {
		/**
		 * Start Better Auth device-code login and save the resulting session.
		 */
		async loginWithDeviceCode({
			onDeviceCode,
			openBrowser: inputOpenBrowser,
		}: {
			onDeviceCode?: (device: {
				userCode: string;
				verificationUriComplete: string;
			}) => void | Promise<void>;
			openBrowser?: (url: string) => Promise<void>;
		} = {}): Promise<Result<MachineAuthLoginResult, MachineAuthError>> {
			let codeData: Awaited<
				ReturnType<AuthServerTransport['requestDeviceCode']>
			>;
			try {
				codeData = await authTransport.requestDeviceCode({ clientId });
			} catch (cause) {
				return MachineAuthError.AuthTransportRequestFailed({ cause });
			}

			const device = {
				userCode: codeData.user_code,
				verificationUriComplete: codeData.verification_uri_complete,
			};
			await onDeviceCode?.(device);
			await (inputOpenBrowser ?? openBrowser)?.(
				codeData.verification_uri_complete,
			);

			let interval = codeData.interval * 1000;
			const deadline = Date.now() + codeData.expires_in * 1000;

			while (Date.now() < deadline) {
				await sleep(interval);
				let tokenData: Awaited<
					ReturnType<AuthServerTransport['pollDeviceToken']>
				>;
				try {
					tokenData = await authTransport.pollDeviceToken({
						deviceCode: codeData.device_code,
						clientId,
					});
				} catch (cause) {
					return MachineAuthError.AuthTransportRequestFailed({ cause });
				}

				if ('access_token' in tokenData) {
					const remote = await fetchSession({
						transport: authTransport,
						token: tokenData.access_token,
					});
					if (remote.error) return remote;
					const saved = await saveStoredSession(remote.data.session);
					if (saved.error) return saved;
					return Ok({
						status: 'loggedIn',
						session: sessionSummary(remote.data.session),
						device,
					});
				}

				switch (tokenData.error) {
					case 'authorization_pending':
						continue;
					case 'slow_down':
						interval += 5_000;
						continue;
					case 'expired_token':
						return MachineAuthError.DeviceCodeExpired();
					case 'access_denied':
						return MachineAuthError.DeviceAccessDenied();
					default:
						return MachineAuthError.DeviceAuthorizationFailed({
							code: tokenData.error,
							description: tokenData.error_description,
						});
				}
			}
			return MachineAuthError.DeviceCodeExpired();
		},

		/**
		 * Read the saved session and verify it remotely when possible.
		 */
		async status(): Promise<Result<MachineAuthStatus, MachineAuthError>> {
			const session = await loadStoredSession();
			if (session.error) return session;
			if (session.data === null) return Ok({ status: 'signedOut' });

			const remote = await fetchSession({
				transport: authTransport,
				token: session.data.token,
			});
			if (remote.error) {
				return Ok({
					status: 'unverified',
					session: sessionSummary(session.data),
					verificationError: remote.error,
				});
			}

			const saved = await saveStoredSession(remote.data.session);
			if (saved.error) return saved;
			return Ok({
				status: 'valid',
				session: sessionSummary(remote.data.session),
			});
		},

		async logout(): Promise<Result<MachineAuthLogoutResult, MachineAuthError>> {
			const session = await loadStoredSession();
			if (session.error) return session;
			if (session.data === null) return Ok({ status: 'signedOut' });

			try {
				await authTransport.signOut({ token: session.data.token });
			} catch {}

			const saved = await saveStoredSession(null);
			if (saved.error) return saved;
			return Ok({ status: 'loggedOut' });
		},

		async getAuthorizationToken(): Promise<
			Result<string | null, MachineAuthError>
		> {
			const session = await loadStoredSession();
			if (session.error) return session;
			return Ok(session.data?.token ?? null);
		},

		async getEncryptionKeys(): Promise<
			Result<EncryptionKeys | null, MachineAuthError>
		> {
			const session = await loadStoredSession();
			if (session.error) return session;
			return Ok(session.data?.encryptionKeys ?? null);
		},

		loadSession(): Promise<Result<AuthSessionType | null, MachineAuthError>> {
			return loadStoredSession();
		},

		saveSession(
			session: AuthSessionType | null,
		): Promise<Result<undefined, MachineAuthError>> {
			return saveStoredSession(session);
		},
	};
}

/**
 * Adapt machine auth to the browser-shaped `SessionStorage` contract.
 */
export function createMachineSessionStorage({
	machineAuth = createMachineAuth(),
}: {
	machineAuth?: MachineAuth;
} = {}): SessionStorage {
	return {
		async load() {
			const result = await machineAuth.loadSession();
			if (result.error) throw result.error;
			return result.data;
		},
		async save(session) {
			const result = await machineAuth.saveSession(session);
			if (result.error) throw result.error;
		},
		watch() {
			return () => {};
		},
	};
}

/**
 * Create an auth client backed by saved machine auth.
 */
export function createMachineAuthClient({
	machineAuth = createMachineAuth(),
}: {
	machineAuth?: MachineAuth;
} = {}): AuthClient {
	return createAuth({
		baseURL: EPICENTER_API_URL,
		sessionStorage: createMachineSessionStorage({ machineAuth }),
	});
}
