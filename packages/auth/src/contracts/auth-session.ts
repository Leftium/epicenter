import type { User as BetterAuthUser } from 'better-auth';
import {
	AuthIdentity,
	AuthUser,
	type BearerSession,
} from '../auth-types.js';

export type AuthSessionResponse = AuthIdentity;

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
 * Project Better Auth user values into the JSON-safe user shape.
 *
 * Better Auth can hand client plugins live `Date` objects before the payload is
 * serialized. Persisted app and machine stores need ISO strings, so this parser
 * owns that conversion at the auth boundary.
 */
export function authUserFromBetterAuthUser(
	value: BetterAuthUser,
): AuthUser {
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
 * Validate the API auth-session response as local identity state.
 *
 * Cookie auth only needs the identity and encryption keys. Bearer clients attach
 * the transport token separately instead of depending on server session shape.
 */
export function authIdentityFromAuthSessionResponse(
	value: unknown,
): AuthIdentity | null {
	if (value === null || value === undefined) return null;

	const identity = AuthIdentity.assert(value);
	return {
		user: {
			id: identity.user.id,
			name: identity.user.name,
			email: identity.user.email,
			emailVerified: identity.user.emailVerified,
			image: identity.user.image,
			createdAt: identity.user.createdAt,
			updatedAt: identity.user.updatedAt,
		},
		encryptionKeys: identity.encryptionKeys,
	};
}

/**
 * Attach a bearer token to the API auth-session response.
 *
 * Better Auth's client plugin typing cannot carry this response through every
 * package boundary in this monorepo, so this function owns the runtime check
 * instead of letting callers trust an inline cast.
 */
export function bearerSessionFromAuthSessionResponse(
	value: unknown,
	{ token }: { token: string },
): BearerSession {
	const identity = authIdentityFromAuthSessionResponse(value);
	if (identity === null) {
		throw new Error('Expected auth-session response to be signed in.');
	}
	return {
		token,
		user: identity.user,
		encryptionKeys: identity.encryptionKeys,
	} satisfies BearerSession;
}
