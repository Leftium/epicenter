/**
 * Instance-token credential unit tests (ADR-0073).
 *
 * Pins the four pieces of the instance bearer path: the resolver maps an exact,
 * constant-time bearer match to the named principal and everything else to
 * `InvalidToken`; the entropy gate fails closed on a missing / short / hand-typed
 * token and passes a strong one; and the generator's output always satisfies the
 * gate (the lockstep that lets the boot error point operators at `gen-token`). The
 * surface wrappers' HTTP/WebSocket shaping is covered in `require-auth.test.ts`.
 */

import { expect, test } from 'bun:test';
import type { Context } from 'hono';
import type { Env } from '../types.js';
import {
	assertStrongToken,
	createInstanceTokenResolver,
	generateInstanceToken,
	INSTANCE_PRINCIPAL,
	MIN_INSTANCE_TOKEN_CHARS,
	verifyEnvToken,
} from './instance-token.js';

const TOKEN = 'instance-token-0123456789abcdef0123456789abcdef';

/** Minimal context exposing only what the resolver reads: the auth header. */
function contextWithAuthorization(value: string | null): Context<Env> {
	return {
		req: {
			header: (name: string) =>
				name.toLowerCase() === 'authorization'
					? (value ?? undefined)
					: undefined,
		},
	} as unknown as Context<Env>;
}

const resolve = createInstanceTokenResolver(verifyEnvToken(TOKEN));

test('resolves the instance principal for an exact bearer match', async () => {
	const { data, error } = await resolve(
		contextWithAuthorization(`Bearer ${TOKEN}`),
	);
	expect(error).toBeNull();
	expect(data).toEqual(INSTANCE_PRINCIPAL);
});

test('rejects a mismatched token with InvalidToken', async () => {
	const { data, error } = await resolve(
		contextWithAuthorization(`Bearer ${TOKEN}-wrong`),
	);
	expect(data).toBeNull();
	expect(error?.name).toBe('InvalidToken');
});

test('rejects a token that is only a prefix of the configured token', async () => {
	const { error } = await resolve(
		contextWithAuthorization(`Bearer ${TOKEN.slice(0, -1)}`),
	);
	expect(error?.name).toBe('InvalidToken');
});

test('rejects a missing Authorization header with InvalidToken', async () => {
	const { error } = await resolve(contextWithAuthorization(null));
	expect(error?.name).toBe('InvalidToken');
});

test('rejects a non-bearer scheme with InvalidToken', async () => {
	const { error } = await resolve(contextWithAuthorization(`Basic ${TOKEN}`));
	expect(error?.name).toBe('InvalidToken');
});

test('generateInstanceToken emits a 256-bit base64url token that clears the gate', () => {
	const token = generateInstanceToken();
	expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
	expect(token.length).toBe(43); // 32 bytes -> 43 base64url chars
	expect(token.length).toBeGreaterThanOrEqual(MIN_INSTANCE_TOKEN_CHARS);
	// Lockstep: the generator must always satisfy the gate, or the boot error
	// would reject a token the operator just generated.
	expect(assertStrongToken(token)).toBe(token);
	expect(generateInstanceToken()).not.toBe(token); // fresh randomness each call
});

test('assertStrongToken fails closed on a missing or empty token', () => {
	expect(() => assertStrongToken(undefined)).toThrow(/not set/);
	expect(() => assertStrongToken('')).toThrow(/not set/);
	expect(() => assertStrongToken('   ')).toThrow(/not set/);
});

test('assertStrongToken fails closed on a short token', () => {
	expect(() => assertStrongToken('letmein')).toThrow(/too weak/);
	expect(() =>
		assertStrongToken('a'.repeat(MIN_INSTANCE_TOKEN_CHARS - 1)),
	).toThrow(/too weak/);
});

test('assertStrongToken fails closed on a passphrase (spaces / control chars)', () => {
	expect(() =>
		assertStrongToken('correct horse battery staple correct horse'),
	).toThrow(/URL-safe/);
});

test('assertStrongToken returns the trimmed token for a strong value', () => {
	expect(assertStrongToken(`  ${TOKEN}  `)).toBe(TOKEN);
});
