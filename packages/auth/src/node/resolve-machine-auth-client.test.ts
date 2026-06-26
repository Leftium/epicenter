/**
 * Tests for the machine auth client resolver.
 *
 * Two surfaces: `readConfiguredToken` (env precedence, injected `env` so no
 * global mutation) and `resolveMachineAuthClient` (the fork: a configured static
 * token yields a settled instance-token client and never touches the OAuth cell;
 * no token falls through to the persisted OAuth cell). The fork tests clear the
 * two env vars so a developer's shell cannot make them flaky.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { asOwnerId } from '@epicenter/identity';
import { createLogger, memorySink } from 'wellcrafted/logger';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { AuthFetch } from '../auth-contract.js';
import { asUserId, type PersistedAuth } from '../auth-types.js';
import {
	readConfiguredToken,
	resolveMachineAuthClient,
} from './resolve-machine-auth-client.js';

const BASE_URL = 'http://localhost:8788';
const TOKEN = 'dev:owner-1';

function sessionBody(ownerId = 'owner-1') {
	return { user: { id: ownerId, email: `${ownerId}@example.com` }, ownerId };
}

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

const cleanupPaths: string[] = [];

function tmpPath() {
	const filePath = path.join(
		os.tmpdir(),
		`epicenter-resolve-${randomUUID()}.json`,
	);
	cleanupPaths.push(filePath);
	return filePath;
}

async function writeCell(filePath: string, cell: PersistedAuth) {
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	await fs.writeFile(filePath, JSON.stringify(cell), { mode: 0o600 });
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

// The resolver reads the real `process.env` by default; clear the two seam vars
// so the OAuth-path tests are deterministic regardless of the dev's shell.
const savedEnv = {
	EPICENTER_TOKEN: process.env.EPICENTER_TOKEN,
	EPICENTER_TOKEN_FILE: process.env.EPICENTER_TOKEN_FILE,
};

beforeEach(() => {
	delete process.env.EPICENTER_TOKEN;
	delete process.env.EPICENTER_TOKEN_FILE;
});

afterAll(async () => {
	if (savedEnv.EPICENTER_TOKEN !== undefined)
		process.env.EPICENTER_TOKEN = savedEnv.EPICENTER_TOKEN;
	if (savedEnv.EPICENTER_TOKEN_FILE !== undefined)
		process.env.EPICENTER_TOKEN_FILE = savedEnv.EPICENTER_TOKEN_FILE;
	for (const filePath of cleanupPaths.splice(0)) {
		try {
			await fs.unlink(filePath);
		} catch {
			// best effort
		}
	}
});

describe('readConfiguredToken', () => {
	test('returns the raw EPICENTER_TOKEN when set', () => {
		expect(readConfiguredToken({ env: { EPICENTER_TOKEN: TOKEN } })).toBe(
			TOKEN,
		);
	});

	test('trims and treats an empty EPICENTER_TOKEN as unset', () => {
		expect(
			readConfiguredToken({ env: { EPICENTER_TOKEN: '   ' } }),
		).toBeUndefined();
	});

	test('raw EPICENTER_TOKEN wins over EPICENTER_TOKEN_FILE', async () => {
		const filePath = tmpPath();
		await fs.writeFile(filePath, 'from-file');
		expect(
			readConfiguredToken({
				env: { EPICENTER_TOKEN: TOKEN, EPICENTER_TOKEN_FILE: filePath },
			}),
		).toBe(TOKEN);
	});

	test('reads and trims EPICENTER_TOKEN_FILE when the raw var is unset', async () => {
		const filePath = tmpPath();
		await fs.writeFile(filePath, `  ${TOKEN}\n`);
		expect(
			readConfiguredToken({ env: { EPICENTER_TOKEN_FILE: filePath } }),
		).toBe(TOKEN);
	});

	test('an unreadable EPICENTER_TOKEN_FILE reads as unset and logs at debug', () => {
		const { sink, events } = memorySink();
		expect(
			readConfiguredToken({
				env: { EPICENTER_TOKEN_FILE: tmpPath() /* never written */ },
				log: createLogger('test', sink),
			}),
		).toBeUndefined();
		expect(events.some((event) => event.level === 'debug')).toBe(true);
	});

	test('no env at all is undefined', () => {
		expect(readConfiguredToken({ env: {} })).toBeUndefined();
	});
});

describe('resolveMachineAuthClient', () => {
	test('a configured token yields a settled, signed-in instance-token client', async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({
				url: String(input),
				authorization: new Headers(init?.headers).get('authorization'),
			});
			return json(sessionBody());
		};

		const auth = expectOk(
			await resolveMachineAuthClient({
				baseURL: BASE_URL,
				token: TOKEN,
				fetch,
			}),
		);

		// The /api/session confirmation is awaited, so state is already settled.
		expect(auth.state).toEqual({
			status: 'signed-in',
			ownerId: asOwnerId('owner-1'),
		});
		expect(calls[0]?.url).toBe(`${BASE_URL}/api/session`);
		expect(calls[0]?.authorization).toBe(`Bearer ${TOKEN}`);
	});

	test('a configured token never touches the OAuth cell on disk', async () => {
		const filePath = tmpPath(); // never created
		const fetch: AuthFetch = async () => json(sessionBody());

		expectOk(
			await resolveMachineAuthClient({
				baseURL: BASE_URL,
				token: TOKEN,
				filePath,
				fetch,
			}),
		);

		expect(await exists(filePath)).toBe(false);
	});

	test('an unverifiable token returns a signed-out client, not an error', async () => {
		const { sink, events } = memorySink();
		const fetch: AuthFetch = async () => json({}, 401);
		const auth = expectOk(
			await resolveMachineAuthClient({
				baseURL: BASE_URL,
				token: TOKEN,
				fetch,
				log: createLogger('test', sink),
			}),
		);
		expect(auth.state.status).toBe('signed-out');
		expect(events.some((event) => event.level === 'debug')).toBe(true);
	});

	test('no configured token + no cell falls through to NoSavedSession', async () => {
		const fetch: AuthFetch = async () => json(sessionBody());
		const error = expectErr(
			await resolveMachineAuthClient({
				baseURL: BASE_URL,
				filePath: tmpPath(),
				fetch,
			}),
		);
		expect(error.name).toBe('NoSavedSession');
	});

	test('no configured token + a stored OAuth cell yields the OAuth client', async () => {
		const filePath = tmpPath();
		await writeCell(filePath, {
			grant: {
				accessToken: 'a',
				refreshToken: 'r',
				accessTokenExpiresAt: 1_700_000_600_000,
			},
			userId: asUserId('owner-1'),
			ownerId: asOwnerId('owner-1'),
		});
		const fetch: AuthFetch = async () => json(sessionBody());

		const auth = expectOk(
			await resolveMachineAuthClient({ baseURL: BASE_URL, filePath, fetch }),
		);

		// The OAuth client seeds state synchronously from the cached cell.
		expect(auth.state).toEqual({
			status: 'signed-in',
			ownerId: asOwnerId('owner-1'),
		});
	});
});
