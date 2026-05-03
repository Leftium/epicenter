import { type } from 'arktype';

export const EncryptionKey = type({
	version: 'number.integer > 0',
	userKeyBase64: 'string',
});

export const EncryptionKeys = type([
	EncryptionKey,
	'...',
	EncryptionKey.array(),
]);

export type EncryptionKey = typeof EncryptionKey.infer;
export type EncryptionKeys = typeof EncryptionKeys.infer;

export function encryptionKeysFingerprint(keys: EncryptionKeys): string {
	return [...keys]
		.sort((a, b) => a.version - b.version)
		.map((k) => `${k.version}:${k.userKeyBase64}`)
		.join(',');
}
