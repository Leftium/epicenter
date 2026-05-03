import { env } from 'cloudflare:workers';
import {
	deriveUserEncryptionKeys as deriveUserEncryptionKeysFromSecrets,
	type EncryptionKeys,
	type EncryptionSecrets,
	parseEncryptionSecrets,
} from '@epicenter/encryption';

let keyring: EncryptionSecrets;
try {
	keyring = parseEncryptionSecrets(env.ENCRYPTION_SECRETS);
} catch (error) {
	throw new Error(
		`ENCRYPTION_SECRETS is missing or malformed. Expected format: "2:base64Secret2,1:base64Secret1" (comma-separated version:secret pairs). Generate a secret with: openssl rand -base64 32\n\nValidation error:\n${error instanceof Error ? error.message : String(error)}`,
	);
}

/**
 * Derive the encryption keyring attached to Better Auth session responses.
 *
 * The API owns env access and fail-fast worker startup. `@epicenter/encryption`
 * owns parsing and HKDF derivation, keeping workspace encryption separate from
 * Better Auth's cookie and token secrets.
 */
export async function deriveUserEncryptionKeys(
	userId: string,
): Promise<EncryptionKeys> {
	return deriveUserEncryptionKeysFromSecrets({
		secrets: keyring,
		userId,
	});
}
