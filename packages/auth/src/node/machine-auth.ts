import type { EncryptionKeys } from '@epicenter/encryption';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Session as AuthSession } from '../auth-types.js';
import type { Session as StoredSession } from '../contracts/session.js';
import { type AuthClient, createAuth } from '../create-auth.js';
import type { SessionStorage } from '../session-store.js';
import {
	type AuthServerTransport,
	createAuthServerTransport,
} from './auth-server-transport.js';
import {
	createMachineCredentialRepository,
	defaultCredentialPath,
	type MachineCredential,
	type MachineCredentialMetadata,
} from './machine-credential-repository.js';
import {
	createKeychainMachineCredentialSecretStorage,
	createPlaintextMachineCredentialSecretStorage,
} from './machine-credential-secret-storage.js';
import { normalizeServerOrigin } from './server-origin.js';

type Clock = { now(): Date };

export const MachineAuthError = defineErrors({
	InvalidServerOrigin: ({
		input,
		cause,
	}: {
		input: string;
		cause: unknown;
	}) => ({
		message: `Expected a server origin like https://api.epicenter.so: ${input}`,
		input,
		cause,
	}),
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
	CredentialStorageFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not read saved machine credentials: ${extractErrorMessage(cause)}`,
		cause,
	}),
	MissingCredentialSecrets: ({ serverOrigin }: { serverOrigin: string }) => ({
		message: `Saved credential secrets are missing for ${serverOrigin}`,
		serverOrigin,
	}),
});
export type MachineAuthError = InferErrors<typeof MachineAuthError>;

export type MachineCredentialStoragePolicy =
	| { kind: 'keychain'; credentialFilePath?: string }
	| { kind: 'plaintextFile'; credentialFilePath?: string };

export type MachineCredentialSummary = {
	serverOrigin: string;
	user: Pick<StoredSession['user'], 'id' | 'name' | 'email'>;
	session: Pick<StoredSession['session'], 'expiresAt'>;
	savedAt: string;
	lastUsedAt: string;
};

export type MachineAuthLoginResult = {
	status: 'loggedIn';
	credential: MachineCredentialSummary;
	device: {
		userCode: string;
		verificationUriComplete: string;
	};
};

export type MachineAuthStatus =
	| { status: 'signedOut' }
	| { status: 'valid'; credential: MachineCredentialSummary }
	| { status: 'expired'; credential: MachineCredentialSummary }
	| {
			status: 'unverified';
			credential: MachineCredentialSummary;
			verificationError: MachineAuthError;
	  }
	| { status: 'missingSecrets'; credential: MachineCredentialSummary };

export type MachineAuthLogoutResult =
	| { status: 'signedOut' }
	| { status: 'loggedOut'; serverOrigin: string };

export type MachineAuth = ReturnType<typeof createMachineAuth>;

type MachineAuthOptions = {
	fetch?: typeof globalThis.fetch;
	credentialStorage?: MachineCredentialStoragePolicy;
	clientId?: string;
	openBrowser?: (url: string) => Promise<void>;
	sleep?: (ms: number) => Promise<void>;
	clock?: Clock;
};

function normalizeOriginResult(
	input: string | URL,
): Result<string, MachineAuthError> {
	try {
		return Ok(normalizeServerOrigin(input));
	} catch (cause) {
		return MachineAuthError.InvalidServerOrigin({
			input: String(input),
			cause,
		});
	}
}

function isExpired(credential: MachineCredential, clock: Clock): boolean {
	return (
		Date.parse(credential.session.session.expiresAt) <= clock.now().getTime()
	);
}

function toAuthSession(credential: MachineCredential): AuthSession {
	return {
		token: credential.bearerToken,
		user: credential.session.user,
		encryptionKeys: credential.session.encryptionKeys,
	};
}

function toStoredSession(
	current: MachineCredential,
	session: AuthSession,
	updatedAt: string,
): StoredSession {
	return {
		user: session.user,
		session: {
			...current.session.session,
			token: session.token,
			userId: session.user.id,
			updatedAt,
		},
		encryptionKeys: session.encryptionKeys,
	};
}

function credentialSummary(
	credential: MachineCredential | MachineCredentialMetadata,
): MachineCredentialSummary {
	return {
		serverOrigin: credential.serverOrigin,
		user: {
			id: credential.session.user.id,
			name: credential.session.user.name,
			email: credential.session.user.email,
		},
		session: {
			expiresAt: credential.session.session.expiresAt,
		},
		savedAt: credential.savedAt,
		lastUsedAt: credential.lastUsedAt,
	};
}

function toAuthTransportError(cause: unknown): MachineAuthError {
	return MachineAuthError.AuthTransportRequestFailed({ cause }).error;
}

export function createMachineAuth({
	fetch: fetchImpl = fetch,
	credentialStorage = { kind: 'keychain' },
	clientId = 'epicenter-cli',
	openBrowser,
	sleep = Bun.sleep,
	clock = { now: () => new Date() },
}: MachineAuthOptions = {}) {
	const credentialFilePath =
		credentialStorage.credentialFilePath ?? defaultCredentialPath();
	const secretStorage =
		credentialStorage.kind === 'plaintextFile'
			? createPlaintextMachineCredentialSecretStorage()
			: createKeychainMachineCredentialSecretStorage();
	const credentialRepository = createMachineCredentialRepository({
		path: credentialFilePath,
		secretStorage,
		clock,
	});

	function transport(serverOrigin: string): AuthServerTransport {
		return createAuthServerTransport({ fetch: fetchImpl }, { serverOrigin });
	}

	async function resolveCredential(input?: {
		serverOrigin?: string | URL;
	}): Promise<Result<MachineCredential | null, MachineAuthError>> {
		try {
			if (input?.serverOrigin === undefined) {
				return Ok(await credentialRepository.getCurrent());
			}
			const origin = normalizeOriginResult(input.serverOrigin);
			if (origin.error) return origin;
			return Ok(await credentialRepository.get(origin.data));
		} catch (cause) {
			return MachineAuthError.CredentialStorageFailed({ cause });
		}
	}

	async function resolveSummary(input?: {
		serverOrigin?: string | URL;
	}): Promise<Result<MachineCredentialSummary | null, MachineAuthError>> {
		try {
			const metadata = await credentialRepository.getMetadata(
				input?.serverOrigin,
			);
			return Ok(metadata === null ? null : credentialSummary(metadata));
		} catch (cause) {
			return MachineAuthError.CredentialStorageFailed({ cause });
		}
	}

	async function resolveMissingSecrets(input?: {
		serverOrigin?: string | URL;
	}): Promise<Result<MachineCredentialSummary | null, MachineAuthError>> {
		const summary = await resolveSummary(input);
		if (summary.error) return summary;
		return summary;
	}

	async function readCredentialField<T>(
		input: { serverOrigin?: string | URL } | undefined,
		read: (credential: MachineCredential) => T | null,
	): Promise<Result<T | null, MachineAuthError>> {
		const credential = await resolveCredential(input);
		if (credential.error) return credential;
		if (credential.data === null) {
			const summary = await resolveMissingSecrets(input);
			if (summary.error) return summary;
			if (summary.data !== null) {
				return MachineAuthError.MissingCredentialSecrets({
					serverOrigin: summary.data.serverOrigin,
				});
			}
			return Ok(null);
		}
		return Ok(read(credential.data));
	}

	return {
		async loginWithDeviceCode({
			serverOrigin,
			onDeviceCode,
			openBrowser: inputOpenBrowser,
		}: {
			serverOrigin: string | URL;
			onDeviceCode?: (device: {
				userCode: string;
				verificationUriComplete: string;
			}) => void | Promise<void>;
			openBrowser?: (url: string) => Promise<void>;
		}): Promise<Result<MachineAuthLoginResult, MachineAuthError>> {
			const origin = normalizeOriginResult(serverOrigin);
			if (origin.error) return origin;
			const authTransport = transport(origin.data);

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
			const deadline = clock.now().getTime() + codeData.expires_in * 1000;

			while (clock.now().getTime() < deadline) {
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
					let remote: Awaited<
						ReturnType<AuthServerTransport['fetchCredentialSession']>
					>;
					try {
						remote = await authTransport.fetchCredentialSession({
							bearerToken: tokenData.access_token,
						});
					} catch (cause) {
						return MachineAuthError.AuthTransportRequestFailed({ cause });
					}
					try {
						const credential = await credentialRepository.save(origin.data, {
							bearerToken: remote.bearerToken,
							session: remote.session,
						});
						return Ok({
							status: 'loggedIn',
							credential: credentialSummary(credential),
							device,
						});
					} catch (cause) {
						return MachineAuthError.CredentialStorageFailed({ cause });
					}
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

		async status(input?: {
			serverOrigin?: string | URL;
		}): Promise<Result<MachineAuthStatus, MachineAuthError>> {
			const credential = await resolveCredential(input);
			if (credential.error) return credential;
			if (credential.data === null) {
				const summary = await resolveMissingSecrets(input);
				if (summary.error) return summary;
				return Ok(
					summary.data === null
						? { status: 'signedOut' }
						: { status: 'missingSecrets', credential: summary.data },
				);
			}
			if (isExpired(credential.data, clock)) {
				return Ok({
					status: 'expired',
					credential: credentialSummary(credential.data),
				});
			}

			const authTransport = transport(credential.data.serverOrigin);
			let remote: Awaited<
				ReturnType<AuthServerTransport['fetchCredentialSession']>
			>;
			try {
				remote = await authTransport.fetchCredentialSession({
					bearerToken: credential.data.bearerToken,
				});
			} catch (cause) {
				return Ok({
					status: 'unverified',
					credential: credentialSummary(credential.data),
					verificationError: toAuthTransportError(cause),
				});
			}

			try {
				const next = await credentialRepository.save(
					credential.data.serverOrigin,
					{
						bearerToken: remote.bearerToken,
						session: remote.session,
					},
				);
				return Ok({ status: 'valid', credential: credentialSummary(next) });
			} catch (cause) {
				return MachineAuthError.CredentialStorageFailed({ cause });
			}
		},

		async logout(input?: {
			serverOrigin?: string | URL;
		}): Promise<Result<MachineAuthLogoutResult, MachineAuthError>> {
			const credential = await resolveCredential(input);
			if (credential.error) return credential;
			if (credential.data === null) return Ok({ status: 'signedOut' });

			try {
				const authTransport = transport(credential.data.serverOrigin);
				await authTransport.signOut({ token: credential.data.bearerToken });
			} catch {}

			try {
				await credentialRepository.clear(credential.data.serverOrigin);
			} catch (cause) {
				return MachineAuthError.CredentialStorageFailed({ cause });
			}
			return Ok({
				status: 'loggedOut',
				serverOrigin: credential.data.serverOrigin,
			});
		},

		getBearerToken(input?: {
			serverOrigin?: string | URL;
		}): Promise<Result<string | null, MachineAuthError>> {
			return readCredentialField(input, (credential) =>
				isExpired(credential, clock) ? null : credential.bearerToken,
			);
		},

		getActiveEncryptionKeys(input?: {
			serverOrigin?: string | URL;
		}): Promise<Result<EncryptionKeys | null, MachineAuthError>> {
			return readCredentialField(input, (credential) =>
				isExpired(credential, clock) ? null : credential.session.encryptionKeys,
			);
		},

		getOfflineEncryptionKeys(input?: {
			serverOrigin?: string | URL;
		}): Promise<Result<EncryptionKeys | null, MachineAuthError>> {
			return readCredentialField(
				input,
				(credential) => credential.session.encryptionKeys,
			);
		},

		loadActiveSession(input: {
			serverOrigin: string | URL;
		}): Promise<Result<AuthSession | null, MachineAuthError>> {
			return readCredentialField(input, (credential) =>
				isExpired(credential, clock) ? null : toAuthSession(credential),
			);
		},

		async saveActiveSession(input: {
			serverOrigin: string | URL;
			session: AuthSession | null;
		}): Promise<Result<undefined, MachineAuthError>> {
			const origin = normalizeOriginResult(input.serverOrigin);
			if (origin.error) return origin;

			try {
				if (input.session === null) {
					await credentialRepository.clear(origin.data);
					return Ok(undefined);
				}

				const current = await credentialRepository.get(origin.data);
				if (current === null) {
					throw new Error(
						`No machine credential exists for ${origin.data}; cannot persist rotated session token.`,
					);
				}
				await credentialRepository.save(origin.data, {
					bearerToken: input.session.token,
					session: toStoredSession(
						current,
						input.session,
						clock.now().toISOString(),
					),
				});
				return Ok(undefined);
			} catch (cause) {
				return MachineAuthError.CredentialStorageFailed({ cause });
			}
		},
	};
}

export function createMachineSessionStorage({
	serverOrigin,
	machineAuth = createMachineAuth(),
}: {
	serverOrigin: string | URL;
	machineAuth?: MachineAuth;
}): SessionStorage {
	if (serverOrigin === undefined) {
		throw MachineAuthError.InvalidServerOrigin({
			input: 'undefined',
			cause: new Error('serverOrigin is required'),
		}).error;
	}

	return {
		async load() {
			const result = await machineAuth.loadActiveSession({ serverOrigin });
			if (result.error) throw result.error;
			return result.data;
		},
		async save(session) {
			const result = await machineAuth.saveActiveSession({
				serverOrigin,
				session,
			});
			if (result.error) throw result.error;
		},
		watch() {
			return () => {};
		},
	};
}

export function createMachineAuthClient({
	serverOrigin,
	machineAuth = createMachineAuth(),
}: {
	serverOrigin: string | URL;
	machineAuth?: MachineAuth;
}): AuthClient {
	return createAuth({
		baseURL: String(serverOrigin),
		sessionStorage: createMachineSessionStorage({
			serverOrigin,
			machineAuth,
		}),
	});
}
