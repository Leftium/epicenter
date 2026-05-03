import { EPICENTER_API_URL } from '@epicenter/constants/apps';
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
import {
	createMachineAuthTransport,
	type MachineAuthTransport,
} from './machine-auth-transport.js';

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

type MachineAuthSessionStorageBackend = {
	get(options: { service: string; name: string }): Promise<string | null>;
	set(options: { service: string; name: string }, value: string): Promise<void>;
	delete(options: { service: string; name: string }): Promise<unknown>;
};

type MachineSessionSummary = {
	user: Pick<AuthSessionType['user'], 'id' | 'name' | 'email'>;
};

type MachineAuthLoginResult = {
	status: 'loggedIn';
	session: MachineSessionSummary;
	device: {
		userCode: string;
		verificationUriComplete: string;
	};
};

type MachineAuthStatus =
	| { status: 'signedOut' }
	| { status: 'valid'; session: MachineSessionSummary }
	| {
			status: 'unverified';
			session: MachineSessionSummary;
			verificationError: MachineAuthError;
	  };

type MachineAuthLogoutResult =
	| { status: 'signedOut' }
	| { status: 'loggedOut' };

export type MachineAuth = ReturnType<typeof createMachineAuth>;

const MACHINE_SESSION_SERVICE = 'epicenter.auth.session';
const MACHINE_SESSION_ACCOUNT = 'current';

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
 * Create an in-memory machine auth store for tests.
 */
export function createMemoryMachineAuthSessionStorageForTest(
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
 * Create the Node-side auth coordinator for first-party CLI and daemon
 * processes.
 */
export function createMachineAuth() {
	const machineAuth = createMachineAuthWithDependencies({
		authTransport: createMachineAuthTransport(),
		sessionStorage: createKeychainMachineAuthSessionStorage(),
	});
	return {
		loginWithDeviceCode: machineAuth.loginWithDeviceCode,
		status: machineAuth.status,
		logout: machineAuth.logout,
		getEncryptionKeys: machineAuth.getEncryptionKeys,
	};
}

export function createMachineAuthWithDependencies({
	authTransport,
	sessionStorage,
	sleep = Bun.sleep,
}: {
	authTransport: MachineAuthTransport;
	sessionStorage: MachineAuthSessionStorage;
	sleep?: (ms: number) => Promise<void>;
}) {
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

	async function fetchSession({ token }: { token: string }) {
		try {
			return Ok(
				await authTransport.fetchSession({
					token,
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
		}: {
			onDeviceCode?: (device: {
				userCode: string;
				verificationUriComplete: string;
			}) => void | Promise<void>;
		} = {}): Promise<Result<MachineAuthLoginResult, MachineAuthError>> {
			let codeData: Awaited<
				ReturnType<MachineAuthTransport['requestDeviceCode']>
			>;
			try {
				codeData = await authTransport.requestDeviceCode();
			} catch (cause) {
				return MachineAuthError.AuthTransportRequestFailed({ cause });
			}

			const device = {
				userCode: codeData.user_code,
				verificationUriComplete: codeData.verification_uri_complete,
			};
			await onDeviceCode?.(device);

			let interval = codeData.interval * 1000;
			const deadline = Date.now() + codeData.expires_in * 1000;

			while (Date.now() < deadline) {
				await sleep(interval);
				let tokenData: Awaited<
					ReturnType<MachineAuthTransport['pollDeviceToken']>
				>;
				try {
					tokenData = await authTransport.pollDeviceToken({
						deviceCode: codeData.device_code,
					});
				} catch (cause) {
					return MachineAuthError.AuthTransportRequestFailed({ cause });
				}

				if ('access_token' in tokenData) {
					const remote = await fetchSession({
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

		async getEncryptionKeys(): Promise<
			Result<EncryptionKeys | null, MachineAuthError>
		> {
			const session = await loadStoredSession();
			if (session.error) return session;
			return Ok(session.data?.encryptionKeys ?? null);
		},
	};
}

/**
 * Create an auth client backed by saved machine auth.
 */
export async function createMachineAuthClient(): Promise<AuthClient> {
	const sessionStorage = createKeychainMachineAuthSessionStorage();
	return createAuth({
		baseURL: EPICENTER_API_URL,
		initialSession: await sessionStorage.load(),
		saveSession: sessionStorage.save,
	});
}
