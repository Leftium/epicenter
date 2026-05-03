import { EncryptionKeys } from '@epicenter/encryption';
import { type } from 'arktype';
import type {
	Session as BetterAuthSession,
	User as BetterAuthUser,
} from 'better-auth';
import type { AuthSession as AuthSessionType } from '../auth-types.js';
import { AuthSession, AuthUser } from '../auth-types.js';

export type BetterAuthSessionResponse = {
	user: BetterAuthUser;
	session: BetterAuthSession;
	encryptionKeys: EncryptionKeys;
};

/**
 * JSON-safe Better Auth session metadata inside an Epicenter credential.
 *
 * Better Auth owns this shape at the database and server-response boundary.
 * Epicenter keeps it because expiry and session identity are useful for
 * machine credential status, but callers should use `authorizationToken` for
 * API requests.
 */
export const AuthServerSessionMetadata = type({
	id: 'string',
	userId: 'string',
	expiresAt: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	'ipAddress?': 'string | null | undefined',
	'userAgent?': 'string | null | undefined',
});
export type AuthServerSessionMetadata = typeof AuthServerSessionMetadata.infer;

export const AuthServerSession = AuthServerSessionMetadata.merge({
	token: 'string',
});
export type AuthServerSession = typeof AuthServerSession.infer;

/**
 * Durable credential aggregate normalized from the auth server.
 *
 * This is the source of truth for authenticated local state. Smaller app
 * session snapshots and machine summaries should be projections of this shape,
 * not sibling contracts with duplicated user or token fields.
 */
export const AuthCredential = type({
	serverOrigin: 'string',
	authorizationToken: 'string',
	user: AuthUser,
	serverSession: AuthServerSession,
	encryptionKeys: EncryptionKeys,
});
export type AuthCredential = typeof AuthCredential.infer;

function readRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Expected ${label} to be an object.`);
	}
	return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== 'string') {
		throw new Error(`Expected ${key} to be a string.`);
	}
	return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
	const value = record[key];
	if (typeof value !== 'boolean') {
		throw new Error(`Expected ${key} to be a boolean.`);
	}
	return value;
}

function normalizeDate(value: unknown, key: string): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string') {
		const time = Date.parse(value);
		if (Number.isNaN(time)) throw new Error(`Expected ${key} to be a date.`);
		return new Date(time).toISOString();
	}
	throw new Error(`Expected ${key} to be a date.`);
}

function normalizeOptionalString(
	record: Record<string, unknown>,
	key: string,
): string | null | undefined {
	const value = record[key];
	if (value === undefined || value === null) return value;
	if (typeof value !== 'string') {
		throw new Error(`Expected ${key} to be a string.`);
	}
	return value;
}

/**
 * Normalize Better Auth user values into the JSON-safe user shape.
 *
 * Better Auth can hand client plugins live `Date` objects before the payload is
 * serialized. Persisted app and machine stores need ISO strings, so this parser
 * owns that conversion at the auth boundary.
 */
export function normalizeAuthUser(value: unknown): AuthUser {
	const record = readRecord(value, 'user');
	return AuthUser.assert({
		id: readString(record, 'id'),
		name: readString(record, 'name'),
		email: readString(record, 'email'),
		emailVerified: readBoolean(record, 'emailVerified'),
		image: normalizeOptionalString(record, 'image'),
		createdAt: normalizeDate(record.createdAt, 'createdAt'),
		updatedAt: normalizeDate(record.updatedAt, 'updatedAt'),
	});
}

/**
 * Normalize Better Auth session metadata into the credential contract.
 *
 * Use this for server responses and tests that construct raw Better Auth
 * payloads. It preserves the server session token as metadata; it does not
 * decide which token should authorize Epicenter API requests.
 */
export function normalizeAuthServerSession(value: unknown): AuthServerSession {
	const record = readRecord(value, 'session');
	return AuthServerSession.assert({
		id: readString(record, 'id'),
		token: readString(record, 'token'),
		userId: readString(record, 'userId'),
		expiresAt: normalizeDate(record.expiresAt, 'expiresAt'),
		createdAt: normalizeDate(record.createdAt, 'createdAt'),
		updatedAt: normalizeDate(record.updatedAt, 'updatedAt'),
		ipAddress: normalizeOptionalString(record, 'ipAddress'),
		userAgent: normalizeOptionalString(record, 'userAgent'),
	});
}

/**
 * Project Better Auth's custom session response into the app session shape.
 *
 * Better Auth's client plugin typing cannot carry this custom response through
 * every package boundary in this monorepo, so this function owns the runtime
 * check instead of letting `createAuth()` trust an inline cast.
 */
export function authSessionFromBetterAuthSessionResponse(
	value: unknown,
): AuthSessionType | null {
	if (value === null || value === undefined) return null;

	const record = readRecord(value, 'Better Auth session response');
	const session = readRecord(record.session, 'session');

	return AuthSession.assert({
		token: readString(session, 'token'),
		user: normalizeAuthUser(record.user),
		encryptionKeys: EncryptionKeys.assert(record.encryptionKeys),
	});
}

/**
 * Build the canonical credential from a raw Better Auth session response.
 *
 * `serverOrigin` and `authorizationToken` come from the transport, not from the
 * Better Auth JSON body. Passing them here keeps origin and token ownership at
 * the same boundary that validated the response.
 */
export function normalizeAuthCredential(
	response: unknown,
	{
		serverOrigin,
		authorizationToken,
	}: { serverOrigin: string; authorizationToken: string },
): AuthCredential {
	const record = readRecord(response, 'session response');
	return AuthCredential.assert({
		serverOrigin,
		authorizationToken,
		user: normalizeAuthUser(record.user),
		serverSession: normalizeAuthServerSession(record.session),
		encryptionKeys: EncryptionKeys.assert(record.encryptionKeys),
	});
}

/**
 * Project a full credential into the smaller session shape used by browser
 * stores and `AuthSnapshot`.
 *
 * The projection keeps the public `session.token` vocabulary while sourcing the
 * value from `authorizationToken`, the token used for Epicenter API requests.
 */
export function authSessionFromCredential(credential: AuthCredential) {
	return {
		token: credential.authorizationToken,
		user: credential.user,
		encryptionKeys: credential.encryptionKeys,
	};
}

/**
 * Refresh credential fields from an app session without overwriting server
 * session identity.
 *
 * App sessions know the authorization token, user, and encryption keys. They do
 * not know whether Better Auth rotated the server session token, so this helper
 * preserves `serverSession.token` from the current credential.
 */
export function authCredentialFromSession({
	current,
	session,
	updatedAt,
}: {
	current: AuthCredential;
	session: {
		token: string;
		user: AuthUser;
		encryptionKeys: EncryptionKeys;
	};
	updatedAt: string;
}): AuthCredential {
	return AuthCredential.assert({
		serverOrigin: current.serverOrigin,
		authorizationToken: session.token,
		user: session.user,
		serverSession: {
			...current.serverSession,
			userId: session.user.id,
			updatedAt,
		},
		encryptionKeys: session.encryptionKeys,
	});
}
