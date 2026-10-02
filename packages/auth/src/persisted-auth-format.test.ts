/**
 * Direct-session storage accepts exactly token and principalId.
 * Obsolete OAuth cells and malformed credentials never become an identity.
 */
import { expect, test } from 'bun:test';
import { PersistedAuth } from './auth-types.js';
import {
	parsePersistedAuth,
	serializePersistedAuth,
} from './persisted-auth-storage.js';

test('the direct-session cell round-trips without grant metadata', () => {
	const cell = PersistedAuth.assert({
		token: 'signed-session',
		principalId: 'alice',
	});
	const serialized = serializePersistedAuth(cell);
	expect(serialized).toBe('{"token":"signed-session","principalId":"alice"}');
	expect(parsePersistedAuth(serialized)).toEqual(cell);
});

test('missing fields, empty tokens, old grants and extra fields are refused', () => {
	for (const value of [
		{},
		{ token: 'token' },
		{ principalId: 'alice' },
		{ token: '', principalId: 'alice' },
		{
			grant: { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: 0 },
			principalId: 'alice',
		},
		{ token: 'a', principalId: 'alice', grant: {} },
	])
		expect(parsePersistedAuth(JSON.stringify(value))).toBeNull();
});
