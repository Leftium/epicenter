import { type } from 'arktype';

/**
 * One deployment secret entry from `ENCRYPTION_SECRETS`.
 *
 * The `secret` string is raw deployment key material, usually generated with
 * `openssl rand -base64 32`. The version has the same one-byte limit as
 * encrypted blobs because it eventually becomes the key version in blob byte 1.
 */
export const EncryptionSecret = type({
	version: '1 <= number.integer <= 255',
	secret: 'string',
});

/**
 * Non-empty deployment secret keyring.
 *
 * The parsed keyring is canonicalized by descending version so the first entry
 * is the current secret for new per-user key derivations.
 */
export const EncryptionSecrets = type([
	EncryptionSecret,
	'...',
	EncryptionSecret.array(),
]);

export type EncryptionSecret = typeof EncryptionSecret.infer;
export type EncryptionSecrets = typeof EncryptionSecrets.infer;

function parseEncryptionSecretEntry(entry: string): EncryptionSecret {
	const separatorIndex = entry.indexOf(':');
	if (separatorIndex === -1) {
		throw new Error('Encryption secret entry must use "version:secret" format');
	}
	const versionText = entry.slice(0, separatorIndex);
	const secret = entry.slice(separatorIndex + 1);
	if (versionText.length === 0) {
		throw new Error('Encryption secret version is required');
	}
	if (secret.length === 0) {
		throw new Error('Encryption secret value is required');
	}
	const parsed = EncryptionSecret({
		version: Number(versionText),
		secret,
	});
	if (parsed instanceof type.errors) {
		throw new Error(parsed.summary);
	}
	return parsed;
}

function sortSecrets(secrets: EncryptionSecrets): EncryptionSecrets {
	return [...secrets].sort(
		(left, right) => right.version - left.version,
	) as EncryptionSecrets;
}

function assertNoDuplicateVersions(secrets: EncryptionSecrets): void {
	const seen = new Set<number>();
	for (const { version } of secrets) {
		if (seen.has(version)) {
			throw new Error(`Duplicate encryption secret version: ${version}`);
		}
		seen.add(version);
	}
}

/**
 * Parse `ENCRYPTION_SECRETS` using the shared `version:secret` grammar.
 *
 * Entries are separated by commas. Each entry splits on the first colon, so
 * secret values may contain colons but not commas. Duplicate versions are
 * rejected because one blob key version must identify exactly one secret.
 *
 * @example
 * ```typescript
 * const secrets = parseEncryptionSecrets('2:newBase64,1:oldBase64');
 * // [{ version: 2, secret: 'newBase64' }, { version: 1, secret: 'oldBase64' }]
 * ```
 */
export function parseEncryptionSecrets(value: string): EncryptionSecrets {
	if (value.length === 0) throw new Error('ENCRYPTION_SECRETS is required');
	const entries = value.split(',').map(parseEncryptionSecretEntry);
	const parsed = EncryptionSecrets(entries);
	if (parsed instanceof type.errors) {
		throw new Error(parsed.summary);
	}
	assertNoDuplicateVersions(parsed);
	return sortSecrets(parsed);
}

/**
 * Format a deployment secret keyring back to canonical env-var text.
 *
 * The output is sorted by descending version to make the current secret visible
 * at the front of the string. This does not preserve input order by design.
 *
 * @example
 * ```typescript
 * formatEncryptionSecrets([
 *   { version: 1, secret: 'oldBase64' },
 *   { version: 2, secret: 'newBase64' },
 * ]);
 * // "2:newBase64,1:oldBase64"
 * ```
 */
export function formatEncryptionSecrets(secrets: EncryptionSecrets): string {
	const parsed = EncryptionSecrets(secrets);
	if (parsed instanceof type.errors) {
		throw new Error(parsed.summary);
	}
	assertNoDuplicateVersions(parsed);
	return sortSecrets(parsed)
		.map(({ version, secret }) => `${version}:${secret}`)
		.join(',');
}
