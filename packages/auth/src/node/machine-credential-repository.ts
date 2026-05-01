import { chmod, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EncryptionKeys as EncryptionKeysData } from '@epicenter/workspace/encryption-key';
import { type } from 'arktype';
import {
	Session,
	type Session as SessionData,
	StoredBetterAuthUser,
} from '../contracts/session.js';
import {
	type MachineCredentialSecretStorage,
	MachineCredentialSecrets,
} from './machine-credential-secret-storage.js';
import { normalizeServerOrigin } from './server-origin.js';

const CREDENTIAL_FILE_VERSION = 'epicenter.auth.credentialStore.v1';

const StoredBetterAuthSessionMetadata = type({
	id: 'string',
	userId: 'string',
	expiresAt: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	'ipAddress?': 'string | null | undefined',
	'userAgent?': 'string | null | undefined',
});
type StoredBetterAuthSessionMetadata =
	typeof StoredBetterAuthSessionMetadata.infer;

const TokenlessMachineSession = type({
	user: StoredBetterAuthUser,
	session: StoredBetterAuthSessionMetadata,
});

const MachineCredentialFileEntry = type({
	serverOrigin: 'string',
	session: TokenlessMachineSession,
	secrets: MachineCredentialSecrets,
	savedAt: 'string',
	lastUsedAt: 'string',
});
type MachineCredentialFileEntry = typeof MachineCredentialFileEntry.infer;

const MachineCredentialFile = type({
	version: "'epicenter.auth.credentialStore.v1'",
	'currentServerOrigin?': 'string | null | undefined',
	credentials: MachineCredentialFileEntry.array(),
});
type MachineCredentialFile = typeof MachineCredentialFile.infer;

const MachineCredential = type({
	serverOrigin: 'string',
	bearerToken: 'string',
	session: Session,
	savedAt: 'string',
	lastUsedAt: 'string',
});
export type MachineCredential = typeof MachineCredential.infer;

export type MachineCredentialMetadata = {
	serverOrigin: string;
	session: typeof TokenlessMachineSession.infer;
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
	entry: MachineCredentialFileEntry;
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
		const session = sessionFromParts({
			entry,
			sessionToken: secrets.sessionToken,
			encryptionKeys: secrets.encryptionKeys,
		});
		return MachineCredential.assert({
			serverOrigin: entry.serverOrigin,
			bearerToken: secrets.bearerToken,
			session,
			savedAt: entry.savedAt,
			lastUsedAt: entry.lastUsedAt,
		});
	}

	async function writeFile(file: MachineCredentialFile): Promise<void> {
		await writeJson(path, MachineCredentialFile.assert(file));
	}

	async function save(
		serverOriginInput: string | URL,
		input: { bearerToken: string; session: SessionData; lastUsedAt?: string },
	): Promise<MachineCredential> {
		await secretStorage.assertAvailable();
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
		const credentialSecrets = await secretStorage.save({
			serverOrigin,
			userId: input.session.user.id,
			values: {
				bearerToken: input.bearerToken,
				sessionToken: input.session.session.token,
				encryptionKeys: input.session.encryptionKeys,
			},
		});

		const entry = MachineCredentialFileEntry.assert({
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
		if (existing) {
			await secretStorage.deleteStale(existing.secrets, credentialSecrets);
		}
		return MachineCredential.assert({
			serverOrigin,
			bearerToken: input.bearerToken,
			session: input.session,
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
			serverOrigin: entry.serverOrigin,
			session: entry.session,
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
