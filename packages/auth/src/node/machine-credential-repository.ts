import { chmod, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EncryptionKeys } from '@epicenter/encryption';
import { type } from 'arktype';
import { AuthUser } from '../auth-types.js';
import {
	AuthCredential,
	AuthServerSessionMetadata,
} from '../contracts/auth-credential.js';
import {
	type MachineCredentialSecretStorage,
	MachineCredentialSecrets,
} from './machine-credential-secret-storage.js';
import { normalizeServerOrigin } from './server-origin.js';

const CREDENTIAL_FILE_VERSION = 'epicenter.auth.credentialStore.v2';

const MachineCredentialMetadataRecord = type({
	user: AuthUser,
	serverSession: AuthServerSessionMetadata,
});

const MachineCredentialFileEntry = type({
	serverOrigin: 'string',
	authCredential: MachineCredentialMetadataRecord,
	secrets: MachineCredentialSecrets,
	savedAt: 'string',
	lastUsedAt: 'string',
});
type MachineCredentialFileEntry = typeof MachineCredentialFileEntry.infer;

const MachineCredentialFile = type({
	version: "'epicenter.auth.credentialStore.v2'",
	'currentServerOrigin?': 'string | null | undefined',
	credentials: MachineCredentialFileEntry.array(),
});
type MachineCredentialFile = typeof MachineCredentialFile.infer;

const MachineCredential = type({
	authCredential: AuthCredential,
	savedAt: 'string',
	lastUsedAt: 'string',
});
export type MachineCredential = typeof MachineCredential.infer;

export type MachineCredentialMetadata = {
	authCredential: typeof MachineCredentialMetadataRecord.infer &
		Pick<AuthCredential, 'serverOrigin'>;
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

/**
 * Keep only non-secret credential fields in the JSON file.
 *
 * Machine status needs user and expiry data even when keychain secrets are
 * missing. Authorization and server-session tokens stay behind the configured
 * secret storage boundary.
 */
function metadataFromCredential(credential: AuthCredential) {
	const { token: _token, ...metadata } = credential.serverSession;
	return {
		user: credential.user,
		serverSession: AuthServerSessionMetadata.assert(metadata),
	};
}

function credentialFromParts({
	entry,
	sessionToken,
	authorizationToken,
	encryptionKeys,
}: {
	entry: MachineCredentialFileEntry;
	sessionToken: string;
	authorizationToken: string;
	encryptionKeys: EncryptionKeys;
}): AuthCredential {
	return AuthCredential.assert({
		serverOrigin: entry.serverOrigin,
		authorizationToken,
		user: entry.authCredential.user,
		serverSession: {
			...entry.authCredential.serverSession,
			token: sessionToken,
		},
		encryptionKeys,
	});
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

function parseCredentialFile(
	value: unknown,
	path: string,
): MachineCredentialFile {
	if (value === null) {
		return {
			version: CREDENTIAL_FILE_VERSION,
			credentials: [],
		};
	}
	try {
		return MachineCredentialFile.assert(value);
	} catch (cause) {
		throw new Error(`Invalid credential file schema: ${path}`, { cause });
	}
}

function latest(entries: MachineCredential[]): MachineCredential | null {
	return (
		entries.toSorted((left, right) =>
			left.lastUsedAt.localeCompare(right.lastUsedAt),
		)[entries.length - 1] ?? null
	);
}

/**
 * Create the file-backed machine credential repository.
 *
 * The JSON file keeps origin, user, session expiry, and save metadata readable
 * for status commands. Sensitive credential values are delegated to the
 * injected secret storage so keychain and plaintext modes share the same
 * runtime `AuthCredential` contract.
 *
 * @example
 * ```ts
 * const repository = createMachineCredentialRepository({
 * 	secretStorage: createKeychainMachineCredentialSecretStorage(),
 * });
 * ```
 */
export function createMachineCredentialRepository({
	path = defaultCredentialPath(),
	secretStorage,
	clock = { now: () => new Date() },
}: {
	path?: string;
	secretStorage: MachineCredentialSecretStorage;
	clock?: Clock;
}) {
	async function readFile(): Promise<MachineCredentialFile> {
		return parseCredentialFile(await readJson(path), path);
	}

	async function resolveEntry(
		entry: MachineCredentialFileEntry,
	): Promise<MachineCredential | null> {
		const secrets = await secretStorage.load(entry.secrets);
		if (secrets === null) return null;
		const authCredential = credentialFromParts({
			entry,
			sessionToken: secrets.serverSessionToken,
			authorizationToken: secrets.authorizationToken,
			encryptionKeys: secrets.encryptionKeys,
		});
		return MachineCredential.assert({
			authCredential,
			savedAt: entry.savedAt,
			lastUsedAt: entry.lastUsedAt,
		});
	}

	async function writeFile(file: MachineCredentialFile): Promise<void> {
		await writeJson(path, MachineCredentialFile.assert(file));
	}

	async function save(
		serverOriginInput: string | URL,
		input: {
			authCredential: AuthCredential;
			lastUsedAt?: string;
		},
	): Promise<MachineCredential> {
		await secretStorage.assertAvailable();
		const serverOrigin = normalizeServerOrigin(serverOriginInput);
		const authCredential = AuthCredential.assert({
			...input.authCredential,
			serverOrigin,
		});
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
		const credentialSecrets = await secretStorage.save({
			serverOrigin,
			userId: authCredential.user.id,
			values: {
				authorizationToken: authCredential.authorizationToken,
				serverSessionToken: authCredential.serverSession.token,
				encryptionKeys: authCredential.encryptionKeys,
			},
		});

		const entry = MachineCredentialFileEntry.assert({
			serverOrigin,
			authCredential: metadataFromCredential(authCredential),
			secrets: credentialSecrets,
			savedAt,
			lastUsedAt,
		});
		await writeFile({
			version: CREDENTIAL_FILE_VERSION,
			currentServerOrigin: serverOrigin,
			credentials: [...preserved, entry],
		});
		if (existing) {
			await secretStorage.deleteStale(existing.secrets, credentialSecrets);
		}
		return MachineCredential.assert({
			authCredential,
			savedAt,
			lastUsedAt,
		});
	}

	async function get(
		serverOriginInput: string | URL,
	): Promise<MachineCredential | null> {
		const serverOrigin = normalizeServerOrigin(serverOriginInput);
		const file = await readFile();
		const entry = file.credentials.find(
			(credential) => credential.serverOrigin === serverOrigin,
		);
		if (entry) return await resolveEntry(entry);
		return null;
	}

	async function getCurrent(): Promise<MachineCredential | null> {
		const file = await readFile();
		if (file.currentServerOrigin) {
			return await get(file.currentServerOrigin);
		}
		const resolved = (
			await Promise.all(file.credentials.map((entry) => resolveEntry(entry)))
		).filter(
			(credential): credential is MachineCredential => credential !== null,
		);
		if (resolved.length > 0) return latest(resolved);
		return null;
	}

	async function getMetadata(
		serverOriginInput?: string | URL,
	): Promise<MachineCredentialMetadata | null> {
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
			authCredential: {
				serverOrigin: entry.serverOrigin,
				...entry.authCredential,
			},
			savedAt: entry.savedAt,
			lastUsedAt: entry.lastUsedAt,
		};
	}

	return {
		save,
		get,
		getCurrent,
		getMetadata,
		async clear(serverOriginInput: string | URL): Promise<void> {
			const serverOrigin = normalizeServerOrigin(serverOriginInput);
			const file = await readFile();
			const removed = file.credentials.find(
				(entry) => entry.serverOrigin === serverOrigin,
			);
			if (removed) await secretStorage.delete(removed.secrets);
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
