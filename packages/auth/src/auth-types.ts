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

export type AuthIdentity = {
	user: AuthUser;
	encryptionKeys: EncryptionKeys;
};

/** Bearer auth state persisted by browser, extension, and machine clients. */
export const BearerSession = type({
	token: 'string',
	user: AuthUser,
	encryptionKeys: EncryptionKeys,
});

export type BearerSession = typeof BearerSession.infer;
