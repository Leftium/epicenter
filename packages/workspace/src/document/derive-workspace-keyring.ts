import {
	base64ToBytes,
	deriveWorkspaceKey,
	type Keyring,
	type WorkspaceKeyring,
} from '@epicenter/encryption';

/**
 * Derive the per-workspace keyring from the authenticated owner keyring.
 *
 * `Keyring` is server-issued owner-scoped material. Workspace encryption does
 * not use it directly; each entry is narrowed with the workspace id so the
 * same owner gets independent keys for different Y.Doc roots.
 */
export function deriveWorkspaceKeyring(
	keyring: Keyring,
	workspaceId: string,
): WorkspaceKeyring {
	const workspaceKeyring: WorkspaceKeyring = new Map();
	for (const { version, keyBytesBase64 } of keyring) {
		const keyBytes = base64ToBytes(keyBytesBase64);
		workspaceKeyring.set(version, deriveWorkspaceKey(keyBytes, workspaceId));
	}
	return workspaceKeyring;
}
