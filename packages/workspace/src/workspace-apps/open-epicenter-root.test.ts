/**
 * Tests for `openEpicenterRoot`, the single daemon entry point.
 *
 * `openEpicenterRoot` imports `epicenter.config.ts`, claims the Epicenter
 * folder, and opens every mount it declares, so these tests drive it through
 * real config files on disk:
 * - a missing config returns a structured `EpicenterConfigNotFound` Result
 * - a valid config opens every declared mount; the result splits into
 *   `started` and `inactive`
 * - the daemon never gates on auth: it loads a session (possibly null) and
 *   hands it to every mount, which decides for itself whether to run
 * - a mount that returns `inactive(reason)` is reported but does not block
 *   its siblings
 * - if any sibling `open(ctx)` throws, the successfully opened runtimes are
 *   asyncDispose'd before the structured error propagates
 * - invalid mount names fail before any mount opens
 * - a populated mount folder blocks bootstrap until `.epicenter/` exists
 *
 * Config-shape validation is pinned separately in
 * `config/load-epicenter-config.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asOwnerId } from '@epicenter/identity';
import { Err, Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';

import type { WorkspaceAuthClient } from './auth-client.js';
import { openEpicenterRoot } from './open-epicenter-root.js';

let epicenterRoot: string;

beforeEach(() => {
	epicenterRoot = mkdtempSync(join(tmpdir(), 'open-epicenter-root-'));
});

afterEach(() => {
	rmSync(epicenterRoot, { recursive: true, force: true });
});

function writeConfig(source: string): void {
	writeFileSync(join(epicenterRoot, 'epicenter.config.ts'), source);
}

function stubAuthClient(): WorkspaceAuthClient {
	return {
		state: {
			status: 'signed-in',
			ownerId: asOwnerId('test-user'),
			keyring: [] as never,
		},
		openWebSocket: () => Promise.resolve({} as WebSocket),
		fetch: () => Promise.resolve(new Response()),
		onStateChange: () => () => {},
	};
}

const signedIn = async () => Ok(stubAuthClient());
const signedOut = async () => Ok(null);

/** A runtime literal whose dispose is a no-op, written into a config. */
const RUNTIME = '{ actions: {}, async [Symbol.asyncDispose]() {} }';

/**
 * A mount that needs the session: it returns a runtime when signed in, else the
 * inline `inactive` signal (a config on disk cannot import `inactive`, but the
 * value is just `{ inactive: true, reason }`).
 */
function sessionMount(name: string): string {
	return `{
		name: '${name}',
		open: (ctx) => ctx.session
			? (${RUNTIME})
			: ({ inactive: true, reason: 'sign in to enable ${name}' }),
	}`;
}

describe('openEpicenterRoot', () => {
	test('returns a structured not-found error instead of throwing', async () => {
		const result = await openEpicenterRoot({
			epicenterRoot,
			loadSession: signedIn,
		});
		const error = expectErr(result);
		expect(error).toMatchObject({
			name: 'EpicenterConfigNotFound',
			epicenterConfigPath: join(epicenterRoot, 'epicenter.config.ts'),
		});
	});

	test('opens every declared mount and claims the folder', async () => {
		writeConfig(
			`export default [
				{ name: 'alpha', open: () => (${RUNTIME}) },
				{ name: 'beta', open: () => (${RUNTIME}) },
			];\n`,
		);

		const result = await openEpicenterRoot({ epicenterRoot });
		const { started, inactive } = expectOk(result);
		expect(
			started
				.map((entry) => entry.mount)
				.slice()
				.sort(),
		).toEqual(['alpha', 'beta']);
		expect(inactive).toEqual([]);
		expect(await Bun.file(join(epicenterRoot, '.gitignore')).exists()).toBe(
			true,
		);
		expect(
			await Bun.file(join(epicenterRoot, '.epicenter', '.gitignore')).exists(),
		).toBe(true);
	});

	test('opens nothing for an empty config', async () => {
		writeConfig('export default [];\n');

		const result = await openEpicenterRoot({ epicenterRoot });
		expect(expectOk(result)).toEqual({ started: [], inactive: [] });
	});

	test('opens local mounts with a null session when signed out', async () => {
		writeConfig(
			`export default [{ name: 'mirror', open: () => (${RUNTIME}) }];\n`,
		);

		const result = await openEpicenterRoot({
			epicenterRoot,
			loadSession: signedOut,
		});
		const { started, inactive } = expectOk(result);
		expect(started.map((entry) => entry.mount)).toEqual(['mirror']);
		expect(inactive).toEqual([]);
	});

	test('reports an inactive mount without blocking its siblings', async () => {
		writeConfig(
			`export default [
				{ name: 'mirror', open: () => (${RUNTIME}) },
				${sessionMount('fuji')},
			];\n`,
		);

		const result = await openEpicenterRoot({
			epicenterRoot,
			loadSession: signedOut,
		});
		const { started, inactive } = expectOk(result);
		expect(started.map((entry) => entry.mount)).toEqual(['mirror']);
		expect(inactive).toEqual([
			{ mount: 'fuji', reason: 'sign in to enable fuji' },
		]);
	});

	test('opens a session mount once signed in', async () => {
		writeConfig(
			`export default [
				{ name: 'mirror', open: () => (${RUNTIME}) },
				${sessionMount('fuji')},
			];\n`,
		);

		const result = await openEpicenterRoot({
			epicenterRoot,
			loadSession: signedIn,
		});
		const { started, inactive } = expectOk(result);
		expect(
			started
				.map((entry) => entry.mount)
				.slice()
				.sort(),
		).toEqual(['fuji', 'mirror']);
		expect(inactive).toEqual([]);
	});

	test('disposes opened runtimes when a sibling open throws', async () => {
		writeConfig(
			`import { writeFileSync } from 'node:fs';
			import { join } from 'node:path';
			const marker = join(import.meta.dirname, 'good.disposed');
			export default [
				{
					name: 'good',
					open: () => ({
						actions: {},
						async [Symbol.asyncDispose]() { writeFileSync(marker, 'disposed'); },
					}),
				},
				{ name: 'bad', open() { throw new Error('boom'); } },
			];\n`,
		);

		const result = await openEpicenterRoot({ epicenterRoot });
		const error = expectErr(result);
		expect(error).toMatchObject({ name: 'MountOpenFailed', mount: 'bad' });
		expect(await Bun.file(join(epicenterRoot, 'good.disposed')).exists()).toBe(
			true,
		);
	});

	test('propagates a genuine session-load error', async () => {
		writeConfig(
			`export default [{ name: 'mirror', open: () => (${RUNTIME}) }];\n`,
		);

		const result = await openEpicenterRoot({
			epicenterRoot,
			loadSession: async () => Err({ name: 'AuthFileUnreadable' } as const),
		});
		expect(expectErr(result)).toMatchObject({ name: 'AuthFileUnreadable' });
	});

	test('rejects invalid mount names before opening any mount', async () => {
		writeConfig(
			`import { writeFileSync } from 'node:fs';
			import { join } from 'node:path';
			export default [
				{
					name: '__proto__',
					open: () => {
						writeFileSync(join(import.meta.dirname, 'opened'), 'opened');
						return ${RUNTIME};
					},
				},
			];\n`,
		);

		const result = await openEpicenterRoot({ epicenterRoot });
		expect(expectErr(result)).toMatchObject({
			name: 'MountRejected',
			mount: '__proto__',
			reason: 'invalid',
		});
		expect(await Bun.file(join(epicenterRoot, 'opened')).exists()).toBe(false);
		expect(await Bun.file(join(epicenterRoot, '.epicenter')).exists()).toBe(
			false,
		);
	});

	test('refuses bootstrap when a mount folder already has files', async () => {
		mkdirSync(join(epicenterRoot, 'fuji'));
		writeFileSync(join(epicenterRoot, 'fuji', 'note.md'), '# mine\n');
		writeConfig(
			`import { writeFileSync } from 'node:fs';
			import { join } from 'node:path';
			export default [
				{
					name: 'fuji',
					open: () => {
						writeFileSync(join(import.meta.dirname, 'opened'), 'opened');
						return ${RUNTIME};
					},
				},
			];\n`,
		);

		const result = await openEpicenterRoot({ epicenterRoot });
		expect(expectErr(result)).toMatchObject({
			name: 'MountFolderNotEmpty',
			mount: 'fuji',
			path: join(epicenterRoot, 'fuji'),
		});
		expect(await Bun.file(join(epicenterRoot, 'opened')).exists()).toBe(false);
		expect(await Bun.file(join(epicenterRoot, '.gitignore')).exists()).toBe(
			false,
		);
		expect(await Bun.file(join(epicenterRoot, '.epicenter')).exists()).toBe(
			false,
		);
	});

	test('returns a structured claim error before opening mounts', async () => {
		writeFileSync(join(epicenterRoot, '.epicenter'), 'not a directory');
		writeConfig(
			`import { writeFileSync } from 'node:fs';
			import { join } from 'node:path';
			export default [
				{
					name: 'fuji',
					open: () => {
						writeFileSync(join(import.meta.dirname, 'opened'), 'opened');
						return ${RUNTIME};
					},
				},
			];\n`,
		);

		const result = await openEpicenterRoot({ epicenterRoot });
		expect(expectErr(result)).toMatchObject({
			name: 'EpicenterFolderClaimFailed',
			epicenterRoot,
		});
		expect(await Bun.file(join(epicenterRoot, 'opened')).exists()).toBe(false);
	});

	test('adopts a populated mount folder once `.epicenter/` exists', async () => {
		mkdirSync(join(epicenterRoot, '.epicenter'));
		mkdirSync(join(epicenterRoot, 'fuji'));
		writeFileSync(join(epicenterRoot, 'fuji', 'note.md'), '# generated\n');
		writeConfig(
			`export default [{ name: 'fuji', open: () => (${RUNTIME}) }];\n`,
		);

		const result = await openEpicenterRoot({ epicenterRoot });
		expect(expectOk(result).started).toHaveLength(1);
	});

	test('ignores OS bookkeeping files when deciding if a folder is populated', async () => {
		mkdirSync(join(epicenterRoot, 'fuji'));
		writeFileSync(join(epicenterRoot, 'fuji', '.DS_Store'), 'finder junk');
		writeConfig(
			`export default [{ name: 'fuji', open: () => (${RUNTIME}) }];\n`,
		);

		const result = await openEpicenterRoot({ epicenterRoot });
		expect(expectOk(result).started).toHaveLength(1);
	});
});
