import type { EncryptionKeys } from '@epicenter/encryption';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { AuthSession } from '../auth-types.js';
import {
	type AuthCredential,
	authCredentialFromSession,
	authSessionFromCredential,
} from '../contracts/auth-credential.js';
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
	user: Pick<AuthCredential['user'], 'id' | 'name' | 'email'>;
	serverSession: Pick<AuthCredential['serverSession'], 'expiresAt'>;
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
		Date.parse(credential.authCredential.serverSession.expiresAt) <=
		clock.now().getTime()
	);
}

function credentialSummary(
	credential: MachineCredential | MachineCredentialMetadata,
): MachineCredentialSummary {
	return {
		serverOrigin: credential.authCredential.serverOrigin,
		user: {
			id: credential.authCredential.user.id,
			name: credential.authCredential.user.name,
			email: credential.authCredential.user.email,
		},
		serverSession: {
			expiresAt: credential.authCredential.serverSession.expiresAt,
		},
		savedAt: credential.savedAt,
		lastUsedAt: credential.lastUsedAt,
	};
}

function toAuthTransportError(cause: unknown): MachineAuthError {
	return MachineAuthError.AuthTransportRequestFailed({ cause }).error;
}

/**
 * Create the Node-side auth coordinator for CLI and daemon processes.
 *
 * Use this when a non-browser process needs to log in with device code auth,
 * verify or refresh saved credentials, and expose the active authorization
 * token or encryption keys to lower-level services.
 *
 * The returned API owns the machine credential lifecycle. It talks to the auth
 * server for fresh credential data, stores the full `AuthCredential` through
 * the repository, and projects smaller values only at the call sites that need
 * them.
 *
 * @example
 * ```ts
 * const machineAuth = createMachineAuth();
 * const token = await machineAuth.getAuthorizationToken({
 * 	serverOrigin: 'https://api.epicenter.so',
 * });
 * ```
 */
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

	async function readCredentialField<T>(
		input: { serverOrigin?: string | URL } | undefined,
		read: (credential: MachineCredential) => T | null,
	): Promise<Result<T | null, MachineAuthError>> {
		const credential = await resolveCredential(input);
		if (credential.error) return credential;
		if (credential.data === null) {
			const summary = await resolveSummary(input);
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
		/**
		 * Start Better Auth device-code login and save the resulting credential.
		 *
		 * The saved credential uses the transport-resolved authorization token,
		 * which may come from `set-auth-token`, and preserves the Better Auth
		 * server session token from the response body.
		 */
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
							authorizationToken: tokenData.access_token,
						});
					} catch (cause) {
						return MachineAuthError.AuthTransportRequestFailed({ cause });
					}
					try {
						const credential = await credentialRepository.save(origin.data, {
							authCredential: remote.authCredential,
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

		/**
		 * Read the saved credential, check local expiry, then verify it remotely
		 * when it still appears active.
		 *
		 * Remote verification also refreshes the saved authorization token when
		 * the server sends `set-auth-token`.
		 */
		async status(input?: {
			serverOrigin?: string | URL;
		}): Promise<Result<MachineAuthStatus, MachineAuthError>> {
			const credential = await resolveCredential(input);
			if (credential.error) return credential;
			if (credential.data === null) {
				const summary = await resolveSummary(input);
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

			const serverOrigin = credential.data.authCredential.serverOrigin;
			const authTransport = transport(serverOrigin);
			let remote: Awaited<
				ReturnType<AuthServerTransport['fetchCredentialSession']>
			>;
			try {
				remote = await authTransport.fetchCredentialSession({
					authorizationToken: credential.data.authCredential.authorizationToken,
				});
			} catch (cause) {
				return Ok({
					status: 'unverified',
					credential: credentialSummary(credential.data),
					verificationError: toAuthTransportError(cause),
				});
			}

			try {
				const next = await credentialRepository.save(serverOrigin, {
					authCredential: remote.authCredential,
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
				const serverOrigin = credential.data.authCredential.serverOrigin;
				const authTransport = transport(serverOrigin);
				await authTransport.signOut({
					token: credential.data.authCredential.authorizationToken,
				});
			} catch {}

			try {
				await credentialRepository.clear(
					credential.data.authCredential.serverOrigin,
				);
			} catch (cause) {
				return MachineAuthError.CredentialStorageFailed({ cause });
			}
			return Ok({
				status: 'loggedOut',
				serverOrigin: credential.data.authCredential.serverOrigin,
			});
		},

		/**
		 * Return the active authorization token for API requests.
		 *
		 * Expired and missing credentials return `Ok(null)`. Missing keychain
		 * secrets return a typed error because a credential metadata record still
		 * exists and the caller needs to surface that integrity problem.
		 */
		getAuthorizationToken(input?: {
			serverOrigin?: string | URL;
		}): Promise<Result<string | null, MachineAuthError>> {
			return readCredentialField(input, (credential) =>
				isExpired(credential, clock)
					? null
					: credential.authCredential.authorizationToken,
			);
		},

		getActiveEncryptionKeys(input?: {
			serverOrigin?: string | URL;
		}): Promise<Result<EncryptionKeys | null, MachineAuthError>> {
			return readCredentialField(input, (credential) =>
				isExpired(credential, clock)
					? null
					: credential.authCredential.encryptionKeys,
			);
		},

		getOfflineEncryptionKeys(input?: {
			serverOrigin?: string | URL;
		}): Promise<Result<EncryptionKeys | null, MachineAuthError>> {
			return readCredentialField(
				input,
				(credential) => credential.authCredential.encryptionKeys,
			);
		},

		/**
		 * Project the active machine credential into app auth storage shape.
		 *
		 * This is the bridge used by `createMachineSessionStorage()`. It does
		 * not expose Better Auth server session metadata to `createAuth()`.
		 */
		loadActiveSession(input: {
			serverOrigin: string | URL;
		}): Promise<Result<AuthSession | null, MachineAuthError>> {
			return readCredentialField(input, (credential) =>
				isExpired(credential, clock)
					? null
					: authSessionFromCredential(credential.authCredential),
			);
		},

		/**
		 * Persist an app auth session back into the machine credential.
		 *
		 * `AuthSession` does not contain the Better Auth server session token, so
		 * this method reads the current credential first and preserves that token
		 * while updating the authorization token, user, and encryption keys.
		 */
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
					authCredential: authCredentialFromSession({
						current: current.authCredential,
						session: input.session,
						updatedAt: clock.now().toISOString(),
					}),
				});
				return Ok(undefined);
			} catch (cause) {
				return MachineAuthError.CredentialStorageFailed({ cause });
			}
		},
	};
}

/**
 * Adapt machine credentials to the browser-shaped `SessionStorage` contract.
 *
 * Use this when code already speaks `createAuth()` and needs to run in a Node
 * process. The adapter deliberately stores only the projected `AuthSession`
 * shape on the `createAuth()` side; the full credential remains owned by
 * `MachineAuth` so Better Auth session metadata and machine secrets stay in
 * one place.
 *
 * @example
 * ```ts
 * const sessionStorage = createMachineSessionStorage({
 * 	serverOrigin: 'https://api.epicenter.so',
 * });
 * ```
 */
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

/**
 * Create an auth client backed by saved machine credentials.
 *
 * This is the Node entry point for code that wants the same auth client surface
 * as browser apps without taking ownership of credential persistence. The
 * machine auth layer remains responsible for login, token rotation, and secret
 * storage.
 *
 * @example
 * ```ts
 * const auth = createMachineAuthClient({
 * 	serverOrigin: 'https://api.epicenter.so',
 * });
 * ```
 */
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
