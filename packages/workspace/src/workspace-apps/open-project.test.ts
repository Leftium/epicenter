/**
 * Tests for `openProject`, the single daemon entry point.
 *
 * `openProject` imports `epicenter.config.ts` and opens every mount it
 * declares, so these tests drive it through real config files on disk:
 * - a missing config returns a structured `ProjectConfigNotFound` Result
 *   (not a throw), so the host surfaces it like any other startup error
 * - a valid config opens every declared mount in parallel
 * - an empty config opens nothing
 * - if any sibling `open(ctx)` throws, the successfully opened runtimes are
 *   asyncDispose'd before the structured error propagates
 * - invalid mount names fail before any mount opens
 * - collaborative mounts require auth before any mount opens
 *
 * Config-shape validation (single -> array, malformed export, syntax errors)
 * is pinned separately in `config/load-project-config.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asOwnerId } from '@epicenter/identity';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';

import type { WorkspaceAuthClient } from './auth-client.js';
import { openProject } from './open-project.js';

let projectDir: string;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), 'open-project-'));
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function writeConfig(source: string): void {
	writeFileSync(join(projectDir, 'epicenter.config.ts'), source);
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

const stubLoadAuth = async () => Ok(stubAuthClient());

/** A mount literal whose runtime disposes cleanly, written into a config. */
const RUNTIME = '{ actions: {}, async [Symbol.asyncDispose]() {} }';

describe('openProject', () => {
	test('returns a structured not-found error instead of throwing', async () => {
		const result = await openProject({
			projectDir,
			loadAuth: stubLoadAuth,
		});
		const error = expectErr(result);
		expect(error).toMatchObject({
			name: 'ProjectConfigNotFound',
			projectConfigPath: join(projectDir, 'epicenter.config.ts'),
		});
	});

	test('imports the config and opens every declared mount', async () => {
		writeConfig(
			`export default [
				{ name: 'alpha', kind: 'collaborative', open: () => (${RUNTIME}) },
				{ name: 'beta', kind: 'collaborative', open: () => (${RUNTIME}) },
			];\n`,
		);

		const result = await openProject({
			projectDir,
			loadAuth: stubLoadAuth,
		});
		const mounts = expectOk(result);
		expect(
			mounts
				.map((entry) => entry.mount)
				.slice()
				.sort(),
		).toEqual(['alpha', 'beta']);
	});

	test('opens nothing for an empty config', async () => {
		writeConfig('export default [];\n');

		const result = await openProject({
			projectDir,
			loadAuth: () => {
				throw new Error('must not load auth');
			},
		});
		expect(expectOk(result)).toEqual([]);
	});

	test('opens local-only mounts without loading auth', async () => {
		writeConfig(
			`export default [
				{ name: 'mirror', kind: 'local', open: () => (${RUNTIME}) },
			];\n`,
		);

		let didLoadAuth = false;
		const result = await openProject({
			projectDir,
			loadAuth: async () => {
				didLoadAuth = true;
				return Ok(stubAuthClient());
			},
		});

		const mounts = expectOk(result);
		expect(mounts.map((entry) => entry.mount)).toEqual(['mirror']);
		expect(didLoadAuth).toBe(false);
	});

	test('rejects a local mount that returns collaboration at runtime', async () => {
		writeConfig(
			`import { writeFileSync } from 'node:fs';
			import { join } from 'node:path';
			const marker = join(import.meta.dirname, 'invalid.disposed');
			export default [
				{
					name: 'mirror',
					kind: 'local',
					open: () => ({
						actions: {},
						collaboration: {},
						async [Symbol.asyncDispose]() { writeFileSync(marker, 'disposed'); },
					}),
				},
			];\n`,
		);

		const result = await openProject({
			projectDir,
			loadAuth: () => {
				throw new Error('must not load auth');
			},
		});

		const error = expectErr(result);
		expect(error).toMatchObject({ name: 'MountOpenFailed', mount: 'mirror' });
		expect(error.message).toContain(
			'Local mount "mirror" returned collaboration',
		);
		expect(await Bun.file(join(projectDir, 'invalid.disposed')).exists()).toBe(
			true,
		);
	});

	test('disposes opened runtimes when a sibling open throws', async () => {
		writeConfig(
			`import { writeFileSync } from 'node:fs';
			import { join } from 'node:path';
			const marker = join(import.meta.dirname, 'good.disposed');
			export default [
				{
					name: 'good',
					kind: 'local',
					open: () => ({
						actions: {},
						async [Symbol.asyncDispose]() { writeFileSync(marker, 'disposed'); },
					}),
				},
				{ name: 'bad', kind: 'local', open() { throw new Error('boom'); } },
			];\n`,
		);

		const result = await openProject({ projectDir });
		const error = expectErr(result);
		expect(error).toMatchObject({ name: 'MountOpenFailed', mount: 'bad' });
		expect(await Bun.file(join(projectDir, 'good.disposed')).exists()).toBe(
			true,
		);
	});

	test('rejects invalid mount names before opening any mount', async () => {
		writeConfig(
			`import { writeFileSync } from 'node:fs';
			import { join } from 'node:path';
			export default [
				{
					name: '__proto__',
					kind: 'local',
					open: () => {
						writeFileSync(join(import.meta.dirname, 'opened'), 'opened');
						return ${RUNTIME};
					},
				},
			];\n`,
		);

		const result = await openProject({
			projectDir,
			loadAuth: () => {
				throw new Error('must not load auth');
			},
		});
		expect(expectErr(result)).toMatchObject({
			name: 'MountRejected',
			mount: '__proto__',
			reason: 'invalid',
		});
		expect(await Bun.file(join(projectDir, 'opened')).exists()).toBe(false);
	});

	test('rejects invalid collaborative mount names before loading auth', async () => {
		writeConfig(
			`export default [
				{
					name: '__proto__',
					kind: 'collaborative',
					open() { throw new Error('must not open'); },
				},
			];\n`,
		);

		const result = await openProject({
			projectDir,
			loadAuth: () => {
				throw new Error('must not load auth');
			},
		});
		expect(expectErr(result)).toMatchObject({
			name: 'MountRejected',
			mount: '__proto__',
			reason: 'invalid',
		});
	});

	test('requires auth for collaborative mounts before opening any mount', async () => {
		writeConfig(
			`export default [{ name: 'alpha', kind: 'collaborative', open() { throw new Error('must not open'); } }];\n`,
		);

		const result = await openProject({
			projectDir,
			loadAuth: async () => Ok(null),
		});
		expect(expectErr(result)).toMatchObject({
			name: 'ProjectAuthRequired',
			mounts: ['alpha'],
		});
	});

	test('requires auth when a collaborative mount has no auth loader', async () => {
		writeConfig(
			`export default [{ name: 'alpha', kind: 'collaborative', open() { throw new Error('must not open'); } }];\n`,
		);

		const result = await openProject({ projectDir });
		expect(expectErr(result)).toMatchObject({
			name: 'ProjectAuthRequired',
			mounts: ['alpha'],
		});
	});

	test('requires auth when a constructed auth client is signed out', async () => {
		writeConfig(
			`export default [{ name: 'alpha', kind: 'collaborative', open() { throw new Error('must not open'); } }];\n`,
		);

		const result = await openProject({
			projectDir,
			loadAuth: async () =>
				Ok({ state: { status: 'signed-out' } } as WorkspaceAuthClient),
		});
		expect(expectErr(result)).toMatchObject({
			name: 'ProjectAuthRequired',
			mounts: ['alpha'],
		});
	});

	test('refuses a mixed signed-out project before opening local siblings', async () => {
		writeConfig(
			`import { writeFileSync } from 'node:fs';
			import { join } from 'node:path';
			export default [
				{
					name: 'mirror',
					kind: 'local',
					open: () => {
						writeFileSync(join(import.meta.dirname, 'opened'), 'opened');
						return ${RUNTIME};
					},
				},
				{ name: 'fuji', kind: 'collaborative', open() { throw new Error('must not open'); } },
			];\n`,
		);

		const result = await openProject({
			projectDir,
			loadAuth: async () => Ok(null),
		});
		expect(expectErr(result)).toMatchObject({
			name: 'ProjectAuthRequired',
			mounts: ['fuji'],
		});
		expect(await Bun.file(join(projectDir, 'opened')).exists()).toBe(false);
	});

	test('opens mixed local and collaborative mounts when signed in', async () => {
		writeConfig(
			`export default [
				{ name: 'mirror', kind: 'local', open: () => (${RUNTIME}) },
				{ name: 'fuji', kind: 'collaborative', open: () => (${RUNTIME}) },
			];\n`,
		);

		const result = await openProject({
			projectDir,
			loadAuth: stubLoadAuth,
		});
		expect(
			expectOk(result)
				.map((entry) => entry.mount)
				.sort(),
		).toEqual(['fuji', 'mirror']);
	});
});
