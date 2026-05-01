import { mkdir, rename, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	EncryptionKeys,
	type EncryptionKeys as EncryptionKeysData,
} from '@epicenter/workspace/encryption-key';
import { type } from 'arktype';
import {
	Session,
	type Session as SessionData,
	StoredBetterAuthUser,
} from '../contracts/session.js';
import {
	createFileSecretStore,
	createKeychainSecretStore,
	type CredentialSecretRef,
	type CredentialSecretStore,
} from './credential-secret-store.js';
import { normalizeServerOrigin } from './server-origin.js';

const CREDENTIAL_FILE_VERSION = 'epicenter.auth.credentialStore.v1';

export const StoredBetterAuthSessionMetadata = type({
	id: 'string',
	userId: 'string',
	expiresAt: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	'ipAddress?': 'string | null | undefined',
	'userAgent?': 'string | null | undefined',
});
export type StoredBetterAuthSessionMetadata =
	typeof StoredBetterAuthSessionMetadata.infer;

export const InlineCredentialSecrets = type({
	storage: "'file'",
	bearerToken: 'string',
	sessionToken: 'string',
	encryptionKeys: EncryptionKeys,
});
export type InlineCredentialSecrets = typeof InlineCredentialSecrets.infer;

export const CredentialSecretRefSchema = type({
	service: 'string',
	account: 'string',
});

export const KeychainCredentialSecrets = type({
	storage: "'osKeychain'",
	bearerTokenRef: CredentialSecretRefSchema,
	sessionTokenRef: CredentialSecretRefSchema,
	encryptionKeysRef: CredentialSecretRefSchema,
});
export type KeychainCredentialSecrets = typeof KeychainCredentialSecrets.infer;

export const CredentialSecrets = InlineCredentialSecrets.or(
	KeychainCredentialSecrets,
);
export type CredentialSecrets = typeof CredentialSecrets.infer;

export const CredentialSession = type({
	user: StoredBetterAuthUser,
	session: StoredBetterAuthSessionMetadata,
});

export const CredentialFileEntry = type({
	serverOrigin: 'string',
	session: CredentialSession,
	secrets: CredentialSecrets,
	savedAt: 'string',
	lastUsedAt: 'string',
});
export type CredentialFileEntry = typeof CredentialFileEntry.infer;

export const CredentialFile = type({
	version: "'epicenter.auth.credentialStore.v1'",
	'currentServerOrigin?': 'string | null | undefined',
	credentials: CredentialFileEntry.array(),
});
export type CredentialFile = typeof CredentialFile.infer;

export const Credential = type({
	serverOrigin: 'string',
	bearerToken: 'string',
	session: Session,
	savedAt: 'string',
	lastUsedAt: 'string',
});
export type Credential = typeof Credential.infer;

export type CredentialStore = ReturnType<typeof createCredentialStore>;
export type CredentialStoreStorageMode = 'file' | 'osKeychain';
export type CredentialMetadata = {
	serverOrigin: string;
	session: typeof CredentialSession.infer;
	savedAt: string;
	lastUsedAt: string;
};

type Clock = { now(): Date };

function resolveEpicenterHome(): string {
	return Bun.env.EPICENTER_HOME ?? join(homedir(), '.epicenter');
}

export function defaultCredentialPath(): string {
	return join(resolveEpicenterHome(), 'auth', 'credentials.json');
}

function isoNow(clock: Clock): string {
	return clock.now().toISOString();
}

function isExpired(session: SessionData, clock: Clock): boolean {
	return Date.parse(session.session.expiresAt) <= clock.now().getTime();
}

function metadataFromSession(session: SessionData) {
	const { token: _token, ...metadata } = session.session;
	return {
		user: session.user,
		session: StoredBetterAuthSessionMetadata.assert(metadata),
	};
}

function sessionFromParts({
	entry,
	sessionToken,
	encryptionKeys,
}: {
	entry: CredentialFileEntry;
	sessionToken: string;
	encryptionKeys: EncryptionKeysData;
}): SessionData {
	return Session.assert({
		user: entry.session.user,
		session: {
			...entry.session.session,
			token: sessionToken,
		},
		encryptionKeys,
	});
}

function keychainRef(
	kind: 'bearerToken' | 'sessionToken' | 'encryptionKeys',
	serverOrigin: string,
	userId: string,
): CredentialSecretRef {
	return {
		service: `epicenter.auth.${kind}`,
		account: `${serverOrigin}:${userId}`,
	};
}

function keychainRefs(secrets: CredentialSecrets): CredentialSecretRef[] {
	if (secrets.storage === 'file') return [];
	return [
		secrets.bearerTokenRef,
		secrets.sessionTokenRef,
		secrets.encryptionKeysRef,
	];
}

function secretRefKey(ref: CredentialSecretRef): string {
	return `${ref.service}:${ref.account}`;
}

async function readJson(path: string): Promise<unknown | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	try {
		return await file.json();
	} catch (cause) {
		throw new Error(`Invalid credential file JSON: ${path}`, { cause });
	}
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${crypto.randomUUID()}.tmp`;
	await Bun.write(temp, JSON.stringify(value, null, '\t'));
	await chmod(temp, 0o600).catch(() => {});
	await rename(temp, path);
	await chmod(path, 0o600).catch(() => {});
}

function parseCredentialFile(value: unknown, path: string): CredentialFile {
	if (value === null) {
		return {
			version: CREDENTIAL_FILE_VERSION,
			credentials: [],
		};
	}
	try {
		return CredentialFile.assert(value);
	} catch (cause) {
		throw new Error(`Invalid credential file schema: ${path}`, { cause });
	}
}

function latest(entries: Credential[]): Credential | null {
	return (
		entries.toSorted((left, right) =>
			left.lastUsedAt.localeCompare(right.lastUsedAt),
		)[entries.length - 1] ?? null
	);
}

export function createCredentialStore({
	path = defaultCredentialPath(),
	storageMode,
	secretStore: injectedSecretStore,
	clock = { now: () => new Date() },
}: {
	path?: string;
	storageMode: CredentialStoreStorageMode;
	secretStore?: CredentialSecretStore;
	clock?: Clock;
}) {
	const secretStore =
		injectedSecretStore ??
		(storageMode === 'osKeychain'
			? createKeychainSecretStore()
			: createFileSecretStore());

	async function assertStorageAvailable() {
		if (storageMode === 'file') return;
		if (!(await secretStore.isAvailable())) {
			throw new Error(
				'OS keychain storage is unavailable. Rerun with --insecure-storage to use plaintext file storage.',
			);
		}
		await secretStore.selfTest();
	}

	async function readFile(): Promise<CredentialFile> {
		return parseCredentialFile(await readJson(path), path);
	}

	async function resolveEntry(
		entry: CredentialFileEntry,
	): Promise<Credential | null> {
		if (entry.secrets.storage === 'file') {
			const session = sessionFromParts({
				entry,
				sessionToken: entry.secrets.sessionToken,
				encryptionKeys: entry.secrets.encryptionKeys,
			});
			return Credential.assert({
				serverOrigin: entry.serverOrigin,
				bearerToken: entry.secrets.bearerToken,
				session,
				savedAt: entry.savedAt,
				lastUsedAt: entry.lastUsedAt,
			});
		}

		const bearerToken = await secretStore.load(entry.secrets.bearerTokenRef);
		const sessionToken = await secretStore.load(entry.secrets.sessionTokenRef);
		const rawEncryptionKeys = await secretStore.load(
			entry.secrets.encryptionKeysRef,
		);
		if (
			bearerToken === null ||
			sessionToken === null ||
			rawEncryptionKeys === null
		) {
			return null;
		}
		let encryptionKeys: EncryptionKeysData;
		try {
			encryptionKeys = EncryptionKeys.assert(JSON.parse(rawEncryptionKeys));
		} catch {
			return null;
		}
		const session = sessionFromParts({ entry, sessionToken, encryptionKeys });
		return Credential.assert({
			serverOrigin: entry.serverOrigin,
			bearerToken,
			session,
			savedAt: entry.savedAt,
			lastUsedAt: entry.lastUsedAt,
		});
	}

	async function writeFile(file: CredentialFile): Promise<void> {
		await writeJson(path, CredentialFile.assert(file));
	}

	async function save(
		serverOriginInput: string | URL,
		input: { bearerToken: string; session: SessionData; lastUsedAt?: string },
	): Promise<Credential> {
		await assertStorageAvailable();
		const serverOrigin = normalizeServerOrigin(serverOriginInput);
		const now = isoNow(clock);
		const file = await readFile();
		const existing = file.credentials.find(
			(entry) => entry.serverOrigin === serverOrigin,
		);
		const preserved = file.credentials.filter(
			(entry) => entry.serverOrigin !== serverOrigin,
		);
		const savedAt = existing?.savedAt ?? now;
		const lastUsedAt = input.lastUsedAt ?? now;
		let credentialSecrets: CredentialSecrets;

		if (storageMode === 'file') {
			credentialSecrets = InlineCredentialSecrets.assert({
				storage: 'file',
				bearerToken: input.bearerToken,
				sessionToken: input.session.session.token,
				encryptionKeys: input.session.encryptionKeys,
			});
		} else {
			const bearerTokenRef = keychainRef(
				'bearerToken',
				serverOrigin,
				input.session.user.id,
			);
			const sessionTokenRef = keychainRef(
				'sessionToken',
				serverOrigin,
				input.session.user.id,
			);
			const encryptionKeysRef = keychainRef(
				'encryptionKeys',
				serverOrigin,
				input.session.user.id,
			);
			await secretStore.save(bearerTokenRef, input.bearerToken);
			await secretStore.save(sessionTokenRef, input.session.session.token);
			await secretStore.save(
				encryptionKeysRef,
				JSON.stringify(input.session.encryptionKeys),
			);
			credentialSecrets = KeychainCredentialSecrets.assert({
				storage: 'osKeychain',
				bearerTokenRef,
				sessionTokenRef,
				encryptionKeysRef,
			});
		}

		const entry = CredentialFileEntry.assert({
			serverOrigin,
			session: metadataFromSession(input.session),
			secrets: credentialSecrets,
			savedAt,
			lastUsedAt,
		});
		await writeFile({
			version: CREDENTIAL_FILE_VERSION,
			currentServerOrigin: serverOrigin,
			credentials: [...preserved, entry],
		});
		if (existing?.secrets.storage === 'osKeychain') {
			const nextRefs = new Set(
				keychainRefs(credentialSecrets).map(secretRefKey),
			);
			await Promise.all(
				keychainRefs(existing.secrets)
					.filter((ref) => !nextRefs.has(secretRefKey(ref)))
					.map((ref) => secretStore.delete(ref)),
			);
		}
		return Credential.assert({
			serverOrigin,
			bearerToken: input.bearerToken,
			session: input.session,
			savedAt,
			lastUsedAt,
		});
	}

	async function get(
		serverOriginInput: string | URL,
	): Promise<Credential | null> {
		const serverOrigin = normalizeServerOrigin(serverOriginInput);
		const file = await readFile();
		const entry = file.credentials.find(
			(credential) => credential.serverOrigin === serverOrigin,
		);
		if (entry) return await resolveEntry(entry);
		return null;
	}

	async function getCurrent(): Promise<Credential | null> {
		const file = await readFile();
		if (file.currentServerOrigin) {
			return await get(file.currentServerOrigin);
		}
		const resolved = (
			await Promise.all(file.credentials.map((entry) => resolveEntry(entry)))
		).filter((credential): credential is Credential => credential !== null);
		if (resolved.length > 0) return latest(resolved);
		return null;
	}

	async function getMetadata(
		serverOriginInput?: string | URL,
	): Promise<CredentialMetadata | null> {
		const file = await readFile();
		const serverOrigin =
			serverOriginInput === undefined
				? file.currentServerOrigin
				: normalizeServerOrigin(serverOriginInput);
		const entry =
			serverOrigin === null || serverOrigin === undefined
				? file.credentials.toSorted((left, right) =>
						left.lastUsedAt.localeCompare(right.lastUsedAt),
					)[file.credentials.length - 1]
				: file.credentials.find(
						(credential) => credential.serverOrigin === serverOrigin,
					);
		if (entry === undefined) return null;
		return {
			serverOrigin: entry.serverOrigin,
			session: entry.session,
			savedAt: entry.savedAt,
			lastUsedAt: entry.lastUsedAt,
		};
	}

	async function getCredential(
		serverOrigin?: string | URL,
	): Promise<Credential | null> {
		return serverOrigin ? await get(serverOrigin) : await getCurrent();
	}

	return {
		save,
		get,
		getCurrent,
		getMetadata,
		async getBearerToken(serverOrigin?: string | URL): Promise<string | null> {
			const credential = await getCredential(serverOrigin);
			if (credential === null || isExpired(credential.session, clock))
				return null;
			return credential.bearerToken;
		},
		async getActiveEncryptionKeys(
			serverOrigin?: string | URL,
		): Promise<EncryptionKeysData | null> {
			const credential = await getCredential(serverOrigin);
			if (credential === null || isExpired(credential.session, clock))
				return null;
			return credential.session.encryptionKeys;
		},
		async getOfflineEncryptionKeys(
			serverOrigin?: string | URL,
		): Promise<EncryptionKeysData | null> {
			const credential = await getCredential(serverOrigin);
			if (credential === null) return null;
			return credential.session.encryptionKeys;
		},
		async clear(serverOriginInput: string | URL): Promise<void> {
			const serverOrigin = normalizeServerOrigin(serverOriginInput);
			const file = await readFile();
			const removed = file.credentials.find(
				(entry) => entry.serverOrigin === serverOrigin,
			);
			if (removed?.secrets.storage === 'osKeychain') {
				await Promise.all([
					secretStore.delete(removed.secrets.bearerTokenRef),
					secretStore.delete(removed.secrets.sessionTokenRef),
					secretStore.delete(removed.secrets.encryptionKeysRef),
				]);
			}
			await writeFile({
				version: CREDENTIAL_FILE_VERSION,
				currentServerOrigin:
					file.currentServerOrigin === serverOrigin
						? null
						: file.currentServerOrigin,
				credentials: file.credentials.filter(
					(entry) => entry.serverOrigin !== serverOrigin,
				),
			});
		},
	};
}
