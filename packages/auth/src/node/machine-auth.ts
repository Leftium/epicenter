import type { EncryptionKeys as EncryptionKeysData } from '@epicenter/workspace/encryption-key';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Session } from '../contracts/session.js';
import {
	createAuthServerClient,
	type AuthServerClient,
} from './auth-server-client.js';
import {
	createCredentialStore,
	defaultCredentialPath,
	type Credential,
	type CredentialMetadata,
} from './credential-store.js';
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
	AuthServerRequestFailed: ({ cause }: { cause: unknown }) => ({
		message: `Auth server request failed: ${extractErrorMessage(cause)}`,
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
	user: Pick<Session['user'], 'id' | 'name' | 'email'>;
	session: Pick<Session['session'], 'expiresAt'>;
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

function storageMode(
	policy: MachineCredentialStoragePolicy,
): 'file' | 'osKeychain' {
	return policy.kind === 'plaintextFile' ? 'file' : 'osKeychain';
}

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

function isExpired(credential: Credential, clock: Clock): boolean {
	return (
		Date.parse(credential.session.session.expiresAt) <= clock.now().getTime()
	);
}

function credentialSummary(
	credential: Credential | CredentialMetadata,
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

function toAuthServerError(cause: unknown): MachineAuthError {
	return MachineAuthError.AuthServerRequestFailed({ cause }).error;
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
	const credentialStore = createCredentialStore({
		path: credentialFilePath,
		storageMode: storageMode(credentialStorage),
		clock,
	});

	function client(serverOrigin: string): AuthServerClient {
		return createAuthServerClient({ fetch: fetchImpl }, { serverOrigin });
	}

	async function resolveCredential(input?: {
		serverOrigin?: string | URL;
	}): Promise<Result<Credential | null, MachineAuthError>> {
		try {
			if (input?.serverOrigin === undefined) {
				return Ok(await credentialStore.getCurrent());
			}
			const origin = normalizeOriginResult(input.serverOrigin);
			if (origin.error) return origin;
			return Ok(await credentialStore.get(origin.data));
		} catch (cause) {
			return MachineAuthError.CredentialStorageFailed({ cause });
		}
	}

	async function resolveSummary(input?: {
		serverOrigin?: string | URL;
	}): Promise<Result<MachineCredentialSummary | null, MachineAuthError>> {
		try {
			const metadata = await credentialStore.getMetadata(input?.serverOrigin);
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
		read: (credential: Credential) => T | null,
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
			const authServer = client(origin.data);

			let codeData: Awaited<ReturnType<AuthServerClient['requestDeviceCode']>>;
			try {
				codeData = await authServer.requestDeviceCode({ clientId });
			} catch (cause) {
				return MachineAuthError.AuthServerRequestFailed({ cause });
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
				let tokenData: Awaited<ReturnType<AuthServerClient['pollDeviceToken']>>;
				try {
					tokenData = await authServer.pollDeviceToken({
						deviceCode: codeData.device_code,
						clientId,
					});
				} catch (cause) {
					return MachineAuthError.AuthServerRequestFailed({ cause });
				}

				if ('access_token' in tokenData) {
					let remote: Awaited<
						ReturnType<AuthServerClient['fetchCredentialSession']>
					>;
					try {
						remote = await authServer.fetchCredentialSession({
							bearerToken: tokenData.access_token,
						});
					} catch (cause) {
						return MachineAuthError.AuthServerRequestFailed({ cause });
					}
					try {
						const credential = await credentialStore.save(origin.data, {
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

			const authServer = client(credential.data.serverOrigin);
			let remote: Awaited<
				ReturnType<AuthServerClient['fetchCredentialSession']>
			>;
			try {
				remote = await authServer.fetchCredentialSession({
					bearerToken: credential.data.bearerToken,
				});
			} catch (cause) {
				return Ok({
					status: 'unverified',
					credential: credentialSummary(credential.data),
					verificationError: toAuthServerError(cause),
				});
			}

			try {
				const next = await credentialStore.save(credential.data.serverOrigin, {
					bearerToken: remote.bearerToken,
					session: remote.session,
				});
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
				const authServer = client(credential.data.serverOrigin);
				await authServer.signOut({ token: credential.data.bearerToken });
			} catch {}

			try {
				await credentialStore.clear(credential.data.serverOrigin);
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
		}): Promise<Result<EncryptionKeysData | null, MachineAuthError>> {
			return readCredentialField(input, (credential) =>
				isExpired(credential, clock) ? null : credential.session.encryptionKeys,
			);
		},

		getOfflineEncryptionKeys(input?: {
			serverOrigin?: string | URL;
		}): Promise<Result<EncryptionKeysData | null, MachineAuthError>> {
			return readCredentialField(
				input,
				(credential) => credential.session.encryptionKeys,
			);
		},
	};
}

export function createMachineTokenGetter({
	serverOrigin,
	machineAuth = createMachineAuth(),
}: {
	serverOrigin: string | URL;
	machineAuth?: Pick<MachineAuth, 'getBearerToken'>;
}) {
	if (serverOrigin === undefined) {
		throw MachineAuthError.InvalidServerOrigin({
			input: 'undefined',
			cause: new Error('serverOrigin is required'),
		}).error;
	}
	return async () => {
		const result = await machineAuth.getBearerToken({ serverOrigin });
		if (result.error) throw result.error;
		return result.data;
	};
}
