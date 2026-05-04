import { EncryptionKeys } from '@epicenter/encryption';
import { type } from 'arktype';

/**
 * JSON-safe user snapshot shared by auth sessions.
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

/** Auth state persisted by browser, extension, and machine clients. */
export const AuthSession = type({
	token: 'string',
	user: AuthUser,
	encryptionKeys: EncryptionKeys,
});

export type AuthSession = typeof AuthSession.infer;

export type AuthSnapshot =
	| { status: 'loading' }
	| { status: 'signedOut' }
	| { status: 'signedIn'; session: AuthSession };

export type AuthSnapshotChangeListener = (snapshot: AuthSnapshot) => void;
