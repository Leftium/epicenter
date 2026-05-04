import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import type { EncryptionKeys } from '@epicenter/encryption';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import {
	BearerSession,
	type BearerSession as BearerSessionType,
} from '../auth-types.js';
import { type AuthClient, createBearerAuth } from '../create-auth.js';
import {
	createMachineAuthTransport,
	type MachineAuthTransport,
	MachineAuthTransportError,
} from './machine-auth-transport.js';

export const MachineAuthStorageError = defineErrors({
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not access machine session storage: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MachineAuthStorageError = InferErrors<
	typeof MachineAuthStorageError
>;

export type MachineAuthError =
	| MachineAuthTransportError
	| MachineAuthStorageError;

export type MachineAuthStorage = {
	load(): Promise<Result<BearerSessionType | null, MachineAuthStorageError>>;
	save(
		session: BearerSessionType | null,
	): Promise<Result<undefined, MachineAuthStorageError>>;
};

export type MachineAuthStorageBackend = {
	get(options: { service: string; name: string }): Promise<string | null>;
	set(options: { service: string; name: string }, value: string): Promise<void>;
	delete(options: { service: string; name: string }): Promise<unknown>;
};

type MachineSessionSummary = {
	user: Pick<BearerSessionType['user'], 'id' | 'name' | 'email'>;
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
			verificationError: MachineAuthTransportError;
	  };

type MachineAuthLogoutResult =
	| { status: 'signedOut' }
	| { status: 'loggedOut' };

function sessionSummary(session: BearerSessionType): MachineSessionSummary {
	return {
		user: {
			id: session.user.id,
			name: session.user.name,
			email: session.user.email,
		},
	};
}

/**
 * Store one machine auth session in the operating system keychain.
 *
 * Machine auth persists the same `BearerSession` shape as bearer auth clients. The
 * server remains the owner of expiry, provider details, and Better Auth session
 * metadata. Corrupt blobs are logged and treated as signed-out so a schema
 * change cannot brick the CLI.
 */
export function createKeychainMachineAuthStorage({
	backend = Bun.secrets,
}: {
	backend?: MachineAuthStorageBackend;
} = {}): MachineAuthStorage {
	const options = { service: 'epicenter.auth.session', name: 'current' };

	return {
		async load() {
			const { data: raw, error } = await tryAsync({
				try: () => backend.get(options),
				catch: (cause) => MachineAuthStorageError.StorageFailed({ cause }),
			});
			if (error) return Err(error);
			if (raw === null) return Ok(null);

			try {
				return Ok(BearerSession.assert(JSON.parse(raw)));
			} catch (cause) {
				console.warn(
					'[machine-auth] discarding corrupted machine session:',
					extractErrorMessage(cause),
				);
				return Ok(null);
			}
		},

		async save(session) {
			return tryAsync({
				try: async (): Promise<undefined> => {
					if (session === null) {
						await backend.delete(options);
					} else {
						await backend.set(
							options,
							JSON.stringify(BearerSession.assert(session)),
						);
					}
					return undefined;
				},
				catch: (cause) => MachineAuthStorageError.StorageFailed({ cause }),
			});
		},
	};
}

export type MachineAuth = ReturnType<typeof createMachineAuth>;

/**
 * Create the Node-side auth coordinator for first-party CLI and daemon
 * processes.
 *
 * Sync construction. Defaults wire the keychain-backed storage and HTTP
 * transport for prod; tests override `transport`, `storage`, and `sleep`.
 */
export function createMachineAuth({
	transport = createMachineAuthTransport(),
	storage = createKeychainMachineAuthStorage(),
	sleep = Bun.sleep,
}: {
	transport?: MachineAuthTransport;
	storage?: MachineAuthStorage;
	sleep?: (ms: number) => Promise<void>;
} = {}) {
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
			const { data: code, error: codeError } =
				await transport.requestDeviceCode();
			if (codeError) return Err(codeError);

			const device = {
				userCode: code.user_code,
				verificationUriComplete: code.verification_uri_complete,
			};
			await onDeviceCode?.(device);

			let interval = code.interval * 1000;
			const deadline = Date.now() + code.expires_in * 1000;
			let accessToken: string | null = null;
			while (Date.now() < deadline) {
				await sleep(interval);
				const { data: poll, error: pollError } =
					await transport.pollDeviceToken({ deviceCode: code.device_code });
				if (pollError) return Err(pollError);
				if (poll.status === 'success') {
					accessToken = poll.accessToken;
					break;
				}
				if (poll.status === 'slowDown') interval += 5_000;
			}
			if (accessToken === null) {
				return MachineAuthTransportError.DeviceCodeExpired();
			}

			const { data: remote, error: fetchError } = await transport.fetchSession({
				token: accessToken,
			});
			if (fetchError) return Err(fetchError);

			const { error: saveError } = await storage.save(remote.session);
			if (saveError) return Err(saveError);

			return Ok({
				status: 'loggedIn',
				session: sessionSummary(remote.session),
				device,
			});
		},

		/**
		 * Read the saved session and verify it remotely when possible. Network
		 * failures surface as `unverified`, not `Err`, so the CLI can show the
		 * cached identity even when offline.
		 */
		async status(): Promise<Result<MachineAuthStatus, MachineAuthError>> {
			const { data: session, error: loadError } = await storage.load();
			if (loadError) return Err(loadError);
			if (session === null) return Ok({ status: 'signedOut' });

			const { data: remote, error: fetchError } = await transport.fetchSession({
				token: session.token,
			});
			if (fetchError) {
				return Ok({
					status: 'unverified',
					session: sessionSummary(session),
					verificationError: fetchError,
				});
			}

			const { error: saveError } = await storage.save(remote.session);
			if (saveError) return Err(saveError);
			return Ok({ status: 'valid', session: sessionSummary(remote.session) });
		},

		async logout(): Promise<Result<MachineAuthLogoutResult, MachineAuthError>> {
			const { data: session, error: loadError } = await storage.load();
			if (loadError) return Err(loadError);
			if (session === null) return Ok({ status: 'signedOut' });

			const { error: signOutError } = await transport.signOut({
				token: session.token,
			});
			if (signOutError) {
				console.warn(
					'[machine-auth] server sign-out failed; clearing local session anyway:',
					signOutError.message,
				);
			}

			const { error: saveError } = await storage.save(null);
			if (saveError) return Err(saveError);
			return Ok({ status: 'loggedOut' });
		},

		async getEncryptionKeys(): Promise<
			Result<EncryptionKeys | null, MachineAuthStorageError>
		> {
			const { data: session, error } = await storage.load();
			if (error) return Err(error);
			return Ok(session?.encryptionKeys ?? null);
		},
	};
}

/**
 * Create an auth client backed by saved machine auth.
 *
 * Storage failures are propagated; daemons should crash rather than silently
 * boot signed-out when the keychain is unreadable.
 */
export async function createMachineAuthClient(): Promise<AuthClient> {
	const storage = createKeychainMachineAuthStorage();
	const { data: initialSession, error } = await storage.load();
	if (error) throw error;
	return createBearerAuth({
		baseURL: EPICENTER_API_URL,
		initialSession,
		saveSession: async (next) => {
			const { error: saveError } = await storage.save(next);
			if (saveError) {
				console.error(
					'[machine-auth] could not save session:',
					saveError.message,
				);
			}
		},
	});
}
