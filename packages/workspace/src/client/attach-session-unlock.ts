/**
 * Apply stored session encryption keys to an encryption attachment.
 */

import type { EncryptionAttachment } from '../document/attach-encryption.js';
import type { SessionStore } from './session-store.js';

export type SessionUnlockAttachment = {
	whenChecked: Promise<unknown>;
};

export function attachSessionUnlock(
	encryption: EncryptionAttachment,
	{
		sessions,
		serverUrl,
		waitFor,
	}: {
		sessions: SessionStore;
		serverUrl: string;
		waitFor?: Promise<unknown>;
	},
): SessionUnlockAttachment {
	const whenChecked = (async () => {
		if (waitFor) await waitFor;
		const session = await sessions.load(serverUrl);
		if (session?.encryptionKeys) {
			encryption.applyKeys(session.encryptionKeys);
		}
	})();
	return { whenChecked };
}
