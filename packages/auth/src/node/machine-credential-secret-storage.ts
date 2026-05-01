import {
	EncryptionKeys,
	type EncryptionKeys as EncryptionKeysData,
} from '@epicenter/workspace/encryption-key';
import { type } from 'arktype';

type MachineCredentialSecretRef = {
	service: string;
	account: string;
};

export type MachineCredentialSecretBackend = {
	get(options: { service: string; name: string }): Promise<string | null>;
	set(options: { service: string; name: string }, value: string): Promise<void>;
	delete(options: { service: string; name: string }): Promise<unknown>;
};

const MachineCredentialSecretRefSchema = type({
	service: 'string',
	account: 'string',
});

export const PlaintextMachineCredentialSecrets = type({
	storage: "'file'",
	bearerToken: 'string',
	sessionToken: 'string',
	encryptionKeys: EncryptionKeys,
});
export type PlaintextMachineCredentialSecrets =
	typeof PlaintextMachineCredentialSecrets.infer;

export const KeychainMachineCredentialSecrets = type({
	storage: "'osKeychain'",
	bearerTokenRef: MachineCredentialSecretRefSchema,
	sessionTokenRef: MachineCredentialSecretRefSchema,
	encryptionKeysRef: MachineCredentialSecretRefSchema,
});
export type KeychainMachineCredentialSecrets =
	typeof KeychainMachineCredentialSecrets.infer;

export const MachineCredentialSecrets = PlaintextMachineCredentialSecrets.or(
	KeychainMachineCredentialSecrets,
);
export type MachineCredentialSecrets = typeof MachineCredentialSecrets.infer;

export type MachineCredentialSecretValues = {
	bearerToken: string;
	sessionToken: string;
	encryptionKeys: EncryptionKeysData;
};

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

function keychainRef(
	kind: 'bearerToken' | 'sessionToken' | 'encryptionKeys',
	serverOrigin: string,
	userId: string,
): MachineCredentialSecretRef {
	return {
		service: `epicenter.auth.${kind}`,
		account: `${serverOrigin}:${userId}`,
	};
}

function keychainRefs(
	secrets: MachineCredentialSecrets,
): MachineCredentialSecretRef[] {
	if (secrets.storage === 'file') return [];
	return [
		secrets.bearerTokenRef,
		secrets.sessionTokenRef,
		secrets.encryptionKeysRef,
	];
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
	return keychainRefs(previous).filter((ref) => !nextRefs.has(secretRefKey(ref)));
}

export function createPlaintextMachineCredentialSecretStorage(): MachineCredentialSecretStorage {
	return {
		async assertAvailable() {},
		async save({ values }) {
			return PlaintextMachineCredentialSecrets.assert({
				storage: 'file',
				bearerToken: values.bearerToken,
				sessionToken: values.sessionToken,
				encryptionKeys: values.encryptionKeys,
			});
		},
		async load(secrets) {
			if (secrets.storage !== 'file') return null;
			return {
				bearerToken: secrets.bearerToken,
				sessionToken: secrets.sessionToken,
				encryptionKeys: secrets.encryptionKeys,
			};
		},
		async delete() {},
		async deleteStale() {},
	};
}

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
			const bearerTokenRef = keychainRef('bearerToken', serverOrigin, userId);
			const sessionTokenRef = keychainRef('sessionToken', serverOrigin, userId);
			const encryptionKeysRef = keychainRef(
				'encryptionKeys',
				serverOrigin,
				userId,
			);
			await backend.set(secretOptions(bearerTokenRef), values.bearerToken);
			await backend.set(secretOptions(sessionTokenRef), values.sessionToken);
			await backend.set(
				secretOptions(encryptionKeysRef),
				JSON.stringify(values.encryptionKeys),
			);
			return KeychainMachineCredentialSecrets.assert({
				storage: 'osKeychain',
				bearerTokenRef,
				sessionTokenRef,
				encryptionKeysRef,
			});
		},
		async load(secrets) {
			if (secrets.storage !== 'osKeychain') return null;
			const bearerToken = await backend.get(
				secretOptions(secrets.bearerTokenRef),
			);
			const sessionToken = await backend.get(
				secretOptions(secrets.sessionTokenRef),
			);
			const rawEncryptionKeys = await backend.get(
				secretOptions(secrets.encryptionKeysRef),
			);
			if (
				bearerToken === null ||
				sessionToken === null ||
				rawEncryptionKeys === null
			) {
				return null;
			}
			try {
				return {
					bearerToken,
					sessionToken,
					encryptionKeys: EncryptionKeys.assert(JSON.parse(rawEncryptionKeys)),
				};
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
