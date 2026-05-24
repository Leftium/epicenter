import { env } from 'cloudflare:workers';
import {
	deriveKeyring as deriveKeyringFromRoot,
	type Keyring,
	parseRootKeyring,
	type RootKeyring,
} from '@epicenter/encryption';

let rootKeyring: RootKeyring;
try {
	rootKeyring = parseRootKeyring(env.ENCRYPTION_SECRETS);
} catch (error) {
	throw new Error(
		`ENCRYPTION_SECRETS is missing or malformed. Expected format: "2:base64Secret2,1:base64Secret1" (comma-separated version:secret pairs). Generate a secret with: openssl rand -base64 32\n\nValidation error:\n${error instanceof Error ? error.message : String(error)}`,
	);
}

/**
 * Derive the workspace `Keyring` attached to Epicenter auth-session responses.
 *
 * The caller (the `/api/session` route) passes the resolved `ownerId` as the
 * HKDF label; this wrapper just owns env access and fail-fast worker startup.
 * `@epicenter/encryption` owns parsing and HKDF derivation, keeping workspace
 * encryption separate from Better Auth's cookie and token secrets.
 */
export async function deriveKeyring(label: string): Promise<Keyring> {
	return deriveKeyringFromRoot({
		rootKeyring,
		label,
	});
}
