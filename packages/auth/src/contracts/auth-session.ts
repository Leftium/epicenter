import { EncryptionKeys } from '@epicenter/encryption';
import { AuthUser, BearerSession } from '../auth-types.js';

export type { BetterAuthSessionResponse } from '../shared/better-auth-session.ts';

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
 * Normalize Better Auth's custom session response into local auth state.
 *
 * Better Auth's client plugin typing cannot carry this custom response through
 * every package boundary in this monorepo, so this function owns the runtime
 * check instead of letting `createBearerAuth()` trust an inline cast.
 */
export function normalizeBearerSession(
	value: unknown,
	{ token }: { token: string },
): BearerSession {
	const record = readRecord(value, 'Better Auth session response');
	return BearerSession.assert({
		token,
		user: normalizeAuthUser(record.user),
		encryptionKeys: EncryptionKeys.assert(record.encryptionKeys),
	});
}

/**
 * Project Better Auth's client subscription value into local auth state.
 *
 * The client subscription already carries the active request token under
 * `session.token`; server-owned session metadata is intentionally ignored.
 */
export function bearerSessionFromBetterAuthSessionResponse(
	value: unknown,
): BearerSession | null {
	if (value === null || value === undefined) return null;

	const record = readRecord(value, 'Better Auth session response');
	const session = readRecord(record.session, 'session');

	return normalizeBearerSession(record, {
		token: readString(session, 'token'),
	});
}
