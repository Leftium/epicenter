/**
 * Instance-token verifier unit tests (ADR-0075).
 *
 * Pins the verifier side of the instance bearer path: the resolver maps an exact,
 * constant-time bearer match to the named principal and everything else to
 * `InvalidToken`. The surface wrappers' HTTP/WebSocket shaping is covered in
 * `require-auth.test.ts`; the pure generator + entropy gate (`generateInstanceToken`
 * / `assertStrongToken`) live in `@epicenter/auth` and are tested there.
 */

import { expect, test } from 'bun:test';
import type { Context } from 'hono';
import type { Env } from '../types.js';
import {
	createInstanceTokenResolver,
	INSTANCE_PRINCIPAL,
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
