import { EncryptionKeys } from '@epicenter/encryption';
import { type } from 'arktype';
import type { AuthCredential } from './contracts/auth-credential.js';

/**
 * JSON-safe user snapshot shared by auth sessions and credentials.
 *
 * Better Auth can produce `Date` objects before serialization. The auth
 * contract normalizes those dates to ISO strings once so every persisted store
 * uses the same user shape.
 */
export const AuthUser = type({
	id: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	email: 'string',
	emailVerified: 'boolean',
	name: 'string',
	'image?': 'string | null | undefined',
});

export type AuthUser = typeof AuthUser.infer;

/**
 * Auth state persisted by browser and extension clients.
 *
 * This is the app-facing projection of the server credential. Richer Better
 * Auth session metadata is normalized at the credential boundary and projected
 * down before it enters `createAuth`.
 */
export const AuthSession = type({
	token: 'string',
	user: AuthUser,
	encryptionKeys: EncryptionKeys,
});

export type AuthSession = {
	token: AuthCredential['authorizationToken'];
	user: AuthCredential['user'];
	encryptionKeys: AuthCredential['encryptionKeys'];
};

export type AuthSnapshot =
	| { status: 'loading' }
	| { status: 'signedOut' }
	| { status: 'signedIn'; session: AuthSession };

export type AuthSnapshotChangeListener = (snapshot: AuthSnapshot) => void;
