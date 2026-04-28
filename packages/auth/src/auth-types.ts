import { EncryptionKeys } from '@epicenter/workspace/encryption-key';
import { type } from 'arktype';

/**
 * Durable user snapshot stored inside an authenticated local session.
 *
 * The auth layer normalizes Better Auth's `Date` values to ISO strings so
 * session persistence stays JSON-friendly across browser storage backends.
 */
export const StoredUser = type({
	id: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	email: 'string',
	emailVerified: 'boolean',
	name: 'string',
	'image?': 'string | null | undefined',
});

export type StoredUser = typeof StoredUser.infer;

/**
 * Shape of an authenticated session.
 *
 * Persisted stores hold `AuthSession | null`—null means not logged in.
 * The session itself is never null; absence is expressed at the store level.
 */
export const AuthSession = type({
	token: 'string',
	user: StoredUser,
	encryptionKeys: EncryptionKeys,
});

export type AuthSession = typeof AuthSession.infer;

