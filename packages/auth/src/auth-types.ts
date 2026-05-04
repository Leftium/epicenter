import { EncryptionKeys } from '@epicenter/encryption';
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
 * Persisted stores hold `Session | null`: null means not logged in.
 * The session itself is never null; absence is expressed at the store level.
 */
export const Session = type({
	token: 'string',
	user: StoredUser,
	encryptionKeys: EncryptionKeys,
});

export type Session = typeof Session.infer;

export type AuthSnapshot =
	| { status: 'loading' }
	| { status: 'signedOut' }
	| { status: 'signedIn'; session: Session };

export type AuthSnapshotChangeListener = (snapshot: AuthSnapshot) => void;
