import {
	base64ToBytes,
	deriveWorkspaceKey,
	type EncryptionKeys,
} from '@epicenter/encryption';

/**
 * Derive a versioned HKDF keyring for a workspace from the owner's user keys.
 * Each version maps to a per-workspace key, used to activate encrypted stores
 * and to seed the encrypted IndexedDB provider.
 */
export function deriveWorkspaceKeyring(
	keys: EncryptionKeys,
	workspaceId: string,
): Map<number, Uint8Array> {
	const keyring = new Map<number, Uint8Array>();
	for (const { version, userKeyBase64 } of keys) {
		const userKey = base64ToBytes(userKeyBase64);
		keyring.set(version, deriveWorkspaceKey(userKey, workspaceId));
	}
	return keyring;
}
