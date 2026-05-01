import {
	EncryptionKeys,
	type EncryptionKeys as EncryptionKeysData,
} from '@epicenter/workspace/encryption-key';
import { type } from 'arktype';
import type {
	Session as BetterAuthSession,
	User as BetterAuthUser,
} from 'better-auth';

export type SessionResponse = {
	user: BetterAuthUser;
	session: BetterAuthSession;
	encryptionKeys: EncryptionKeysData;
};

export const StoredBetterAuthUser = type({
	id: 'string',
	name: 'string',
	email: 'string',
	emailVerified: 'boolean',
	'image?': 'string | null | undefined',
	createdAt: 'string',
	updatedAt: 'string',
});
export type StoredBetterAuthUser = typeof StoredBetterAuthUser.infer;

export const StoredBetterAuthSession = type({
	id: 'string',
	token: 'string',
	userId: 'string',
	expiresAt: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	'ipAddress?': 'string | null | undefined',
	'userAgent?': 'string | null | undefined',
});
export type StoredBetterAuthSession = typeof StoredBetterAuthSession.infer;

export const Session = type({
	user: StoredBetterAuthUser,
	session: StoredBetterAuthSession,
	encryptionKeys: EncryptionKeys,
});
export type Session = typeof Session.infer;

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

export function normalizeUserForStorage(
	value: unknown,
): StoredBetterAuthUser {
	const record = readRecord(value, 'user');
	return StoredBetterAuthUser.assert({
		id: readString(record, 'id'),
		name: readString(record, 'name'),
		email: readString(record, 'email'),
		emailVerified: readBoolean(record, 'emailVerified'),
		image: normalizeOptionalString(record, 'image'),
		createdAt: normalizeDate(record.createdAt, 'createdAt'),
		updatedAt: normalizeDate(record.updatedAt, 'updatedAt'),
	});
}

export function normalizeBetterAuthSessionForStorage(
	value: unknown,
): StoredBetterAuthSession {
	const record = readRecord(value, 'session');
	return StoredBetterAuthSession.assert({
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

export function normalizeSessionResponse(response: unknown): Session {
	const record = readRecord(response, 'session response');
	return Session.assert({
		user: normalizeUserForStorage(record.user),
		session: normalizeBetterAuthSessionForStorage(record.session),
		encryptionKeys: EncryptionKeys.assert(record.encryptionKeys),
	});
}
