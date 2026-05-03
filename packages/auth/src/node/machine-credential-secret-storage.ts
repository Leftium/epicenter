import { EncryptionKeys } from '@epicenter/encryption';
import { type } from 'arktype';

type MachineCredentialSecretRef = {
	service: string;
	account: string;
};

/**
 * Minimal Bun.secrets-compatible surface used by keychain storage.
 *
 * Tests inject an in-memory backend through this contract. Production defaults
 * to `Bun.secrets`, so the rest of the auth layer does not know whether secrets
 * are stored in the OS keychain or a test vault.
 */
export type MachineCredentialSecretBackend = {
	get(options: { service: string; name: string }): Promise<string | null>;
	set(options: { service: string; name: string }, value: string): Promise<void>;
	delete(options: { service: string; name: string }): Promise<unknown>;
};

const MachineCredentialSecretRefSchema = type({
	service: 'string',
	account: 'string',
});

/**
 * Sensitive values removed from the machine credential JSON file.
 *
 * The repository stores these values together because they are loaded and
 * deleted as one credential. Splitting them into separate keychain entries
 * would create partial-failure states that the caller cannot use safely.
 */
export const MachineCredentialSecretValues = type({
	authorizationToken: 'string',
	serverSessionToken: 'string',
	encryptionKeys: EncryptionKeys,
});
export type MachineCredentialSecretValues =
	typeof MachineCredentialSecretValues.infer;

/**
 * Plaintext secret payload embedded directly in the credential file.
 *
 * This variant is for tests and explicit plaintext storage mode. It keeps the
 * same `values` object as keychain storage so repository code handles both
 * modes through one secret contract.
 */
export const PlaintextMachineCredentialSecrets = type({
	storage: "'file'",
	values: MachineCredentialSecretValues,
});
export type PlaintextMachineCredentialSecrets =
	typeof PlaintextMachineCredentialSecrets.infer;

/**
 * Pointer to a keychain blob containing all sensitive credential values.
 *
 * The credential file keeps only this reference. Loading the full credential
 * requires resolving the blob and validating it as `MachineCredentialSecretValues`.
 */
export const KeychainMachineCredentialSecrets = type({
	storage: "'osKeychain'",
	credentialRef: MachineCredentialSecretRefSchema,
});
export type KeychainMachineCredentialSecrets =
	typeof KeychainMachineCredentialSecrets.infer;

/**
 * Serialized secret location for one saved machine credential.
 *
 * `file` stores the secret values inline. `osKeychain` stores a reference that
 * must be resolved before the repository can rebuild an `AuthCredential`.
 */
export const MachineCredentialSecrets = PlaintextMachineCredentialSecrets.or(
	KeychainMachineCredentialSecrets,
);
export type MachineCredentialSecrets = typeof MachineCredentialSecrets.infer;

/**
 * Persistence boundary for machine credential secrets.
 *
 * The repository owns credential-file structure. This storage owns only the
 * sensitive values and returns a serializable `MachineCredentialSecrets` marker
 * that can be written beside non-secret metadata.
 */
export type MachineCredentialSecretStorage = {
	assertAvailable(): Promise<void>;
	save(input: {
		serverOrigin: string;
		userId: string;
		values: MachineCredentialSecretValues;
	}): Promise<MachineCredentialSecrets>;
	load(
		secrets: MachineCredentialSecrets,
	): Promise<MachineCredentialSecretValues | null>;
	delete(secrets: MachineCredentialSecrets): Promise<void>;
	deleteStale(
		previous: MachineCredentialSecrets,
		next: MachineCredentialSecrets,
	): Promise<void>;
};

/**
 * Store all sensitive credential values as one secret.
 *
 * The repository always saves, loads, and deletes authorization token, server
 * session token, and encryption keys together. A single keychain blob keeps the
 * storage shape aligned with that lifecycle and avoids stale partial refs.
 */
function credentialKeychainRef(
	serverOrigin: string,
	userId: string,
): MachineCredentialSecretRef {
	return {
		service: 'epicenter.auth.credential',
		account: `${serverOrigin}:${userId}`,
	};
}

function keychainRefs(
	secrets: MachineCredentialSecrets,
): MachineCredentialSecretRef[] {
	if (secrets.storage === 'file') return [];
	return [secrets.credentialRef];
}

function secretRefKey(ref: MachineCredentialSecretRef): string {
	return `${ref.service}:${ref.account}`;
}

function secretOptions(ref: MachineCredentialSecretRef) {
	return {
		service: ref.service,
		name: ref.account,
	};
}

function staleKeychainRefs(
	previous: MachineCredentialSecrets,
	next: MachineCredentialSecrets,
): MachineCredentialSecretRef[] {
	const nextRefs = new Set(keychainRefs(next).map(secretRefKey));
	return keychainRefs(previous).filter(
		(ref) => !nextRefs.has(secretRefKey(ref)),
	);
}

/**
 * Keep credential secrets inline in the credential JSON file.
 *
 * Use this for tests, local debugging, or environments where the caller has
 * explicitly chosen a plaintext credential store. The storage still validates
 * the same one-blob secret shape as keychain mode, so repository behavior does
 * not branch by secret layout.
 *
 * @example
 * ```ts
 * const secretStorage = createPlaintextMachineCredentialSecretStorage();
 * ```
 */
export function createPlaintextMachineCredentialSecretStorage(): MachineCredentialSecretStorage {
	return {
		async assertAvailable() {},
		async save({ values }) {
			return PlaintextMachineCredentialSecrets.assert({
				storage: 'file',
				values,
			});
		},
		async load(secrets) {
			if (secrets.storage !== 'file') return null;
			return secrets.values;
		},
		async delete() {},
		async deleteStale() {},
	};
}

/**
 * Store machine credential secrets in the operating system keychain.
 *
 * Use this for normal CLI and daemon auth. Authorization token, server session
 * token, and encryption keys are serialized together because the repository
 * saves and deletes them as one credential. A self-test runs before saving so
 * callers fail before mutating the credential file when the keychain is not
 * available.
 *
 * @example
 * ```ts
 * const secretStorage = createKeychainMachineCredentialSecretStorage();
 * ```
 */
export function createKeychainMachineCredentialSecretStorage({
	backend = Bun.secrets,
}: {
	backend?: MachineCredentialSecretBackend;
} = {}): MachineCredentialSecretStorage {
	return {
		async assertAvailable() {
			const ref = {
				service: 'epicenter.auth.selfTest',
				account: crypto.randomUUID(),
			};
			await backend.set(secretOptions(ref), 'ok');
			try {
				const value = await backend.get(secretOptions(ref));
				if (value !== 'ok') throw new Error('OS keychain self-test failed.');
			} finally {
				await backend.delete(secretOptions(ref)).catch(() => {});
			}
		},
		async save({ serverOrigin, userId, values }) {
			const credentialRef = credentialKeychainRef(serverOrigin, userId);
			await backend.set(
				secretOptions(credentialRef),
				JSON.stringify(MachineCredentialSecretValues.assert(values)),
			);
			return KeychainMachineCredentialSecrets.assert({
				storage: 'osKeychain',
				credentialRef,
			});
		},
		async load(secrets) {
			if (secrets.storage !== 'osKeychain') return null;
			const rawCredential = await backend.get(
				secretOptions(secrets.credentialRef),
			);
			if (rawCredential === null) return null;
			try {
				return MachineCredentialSecretValues.assert(JSON.parse(rawCredential));
			} catch {
				return null;
			}
		},
		async delete(secrets) {
			await Promise.all(
				keychainRefs(secrets).map((ref) => backend.delete(secretOptions(ref))),
			);
		},
		async deleteStale(previous, next) {
			await Promise.all(
				staleKeychainRefs(previous, next).map((ref) =>
					backend.delete(secretOptions(ref)),
				),
			);
		},
	};
}
