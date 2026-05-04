/**
 * Fuji Node Integration Tests
 *
 * Verifies daemon and script handoff through the local Yjs log, including
 * remote actions and offline decryption of encrypted snapshot rows.
 *
 * Key behaviors:
 * - Script readers hydrate rows written by the daemon
 * - Script actions call daemon actions through RPC
 * - Offline keys unlock encrypted log rows
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { AuthClient } from '@epicenter/auth';
import type { EncryptionKeys } from '@epicenter/encryption';
import type { ProjectDir } from '@epicenter/workspace';
import type { DaemonRuntime } from '@epicenter/workspace/daemon';
import {
	attachYjsLog,
	claimDaemonLease,
	type DaemonLease,
	type DaemonServer,
	startDaemonServer,
	yjsPath,
} from '@epicenter/workspace/node';
import {
	mintTestProjectDir,
	NoopWebSocket,
} from '@epicenter/workspace/test-utils';
import { DEFAULT_FUJI_DAEMON_ROUTE, defineFujiDaemon } from './daemon.js';
import { openFuji as openFujiDoc } from './index.js';
import { openFujiScript, openFujiSnapshot } from './script.js';

let workdir: ProjectDir;
let oldEpicenterHome: string | undefined;

const testEncryptionKeys: EncryptionKeys = [
	{
		version: 1,
		userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
];

function createTestAuth(): AuthClient {
	return {
		snapshot: {
			status: 'signedIn',
			session: {
				token: 'fake-token',
				user: {
					id: 'test-user',
					createdAt: '2026-05-03T00:00:00.000Z',
					updatedAt: '2026-05-03T00:00:00.000Z',
					email: 'test@example.com',
					emailVerified: true,
					name: 'Test User',
				},
				encryptionKeys: testEncryptionKeys,
			},
		},
		whenLoaded: Promise.resolve(),
		onSnapshotChange() {
			return () => {};
		},
		async signIn() {
			throw new Error('unused');
		},
		async signUp() {
			throw new Error('unused');
		},
		async signInWithSocialPopup() {
			throw new Error('unused');
		},
		async signInWithSocialRedirect() {
			throw new Error('unused');
		},
		async signOut() {
			throw new Error('unused');
		},
		fetch: globalThis.fetch.bind(globalThis),
		[Symbol.dispose]() {},
	};
}

beforeEach(() => {
	workdir = mintTestProjectDir('fuji-integration-');
	oldEpicenterHome = Bun.env.EPICENTER_HOME;
	Bun.env.EPICENTER_HOME = `${workdir}/home`;
});

afterEach(() => {
	if (oldEpicenterHome === undefined) {
		delete Bun.env.EPICENTER_HOME;
	} else {
		Bun.env.EPICENTER_HOME = oldEpicenterHome;
	}
	rmSync(workdir, { recursive: true, force: true });
});

describe('daemon to script handoff via Yjs log file', () => {
	test('script warm hydrates entries the daemon wrote', async () => {
		{
			const routeDefinition = defineFujiDaemon({
				auth: createTestAuth(),
				webSocketImpl: NoopWebSocket,
			});
			const daemon = (await routeDefinition.start({
				projectDir: workdir,
				route: DEFAULT_FUJI_DAEMON_ROUTE,
			})) as ReturnType<typeof openFujiDoc> & DaemonRuntime;

			try {
				for (const title of ['first', 'second', 'third']) {
					daemon.actions.entries.create({ title });
				}
			} finally {
				await daemon[Symbol.asyncDispose]();
			}
		}

		using script = await openFujiSnapshot({ projectDir: workdir });
		const titles = script.tables.entries
			.getAllValid()
			.map((row) => row.title)
			.sort();
		expect(titles).toEqual(['first', 'second', 'third']);
	});

	test('script actions read and write through the daemon', async () => {
		await Bun.write(`${workdir}/epicenter.config.ts`, 'export default {};');

		const routeDefinition = defineFujiDaemon({
			auth: createTestAuth(),
			webSocketImpl: NoopWebSocket,
		});
		const daemon = await routeDefinition.start({
			projectDir: workdir,
			route: DEFAULT_FUJI_DAEMON_ROUTE,
		});
		const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
		let lease: DaemonLease | null = null;
		let server: DaemonServer | null = null;
		try {
			process.env.XDG_RUNTIME_DIR = '/tmp';
			const leaseResult = claimDaemonLease(workdir);
			expect(leaseResult.error).toBeNull();
			if (leaseResult.error !== null) throw new Error('expected daemon lease');
			lease = leaseResult.data;
			const serverResult = await startDaemonServer({
				lease,
				routes: [
					{
						route: DEFAULT_FUJI_DAEMON_ROUTE,
						runtime: daemon,
					},
				],
			});
			expect(serverResult.error).toBeNull();
			if (serverResult.error !== null) throw serverResult.error;
			server = serverResult.data;

			await using script = await openFujiScript({ projectDir: workdir });
			const created = await script.actions.entries.create({
				title: 'daemon backed',
			});
			expect(created.error).toBeNull();
			if (created.error !== null) return;

			const updated = await script.actions.entries.update({
				id: created.data.id,
				tags: ['script'],
			});
			expect(updated.error).toBeNull();

			const fresh = await script.actions.entries.getAllValid({});
			expect(fresh.error).toBeNull();
			if (fresh.error !== null) return;
			expect(fresh.data.map((row) => row.title)).toContain('daemon backed');
			expect(
				fresh.data.find((row) => row.id === created.data.id)?.tags,
			).toEqual(['script']);

			const snapshot = await openFujiSnapshot({ projectDir: workdir });
			using _snapshot = snapshot;
			expect(
				snapshot.tables.entries
					.getAllValid()
					.some((row) => row.id === created.data.id),
			).toBe(true);
		} finally {
			if (server) {
				await server.close().catch(() => {
					// best-effort
				});
			}
			lease?.release();
			try {
				await daemon[Symbol.asyncDispose]();
			} finally {
				if (oldRuntimeDir === undefined) {
					delete process.env.XDG_RUNTIME_DIR;
				} else {
					process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
				}
			}
		}
	});

	test('script snapshot uses offline keys for encrypted log rows', async () => {
		const writer = openFujiDoc();
		const yjsLog = attachYjsLog(writer.ydoc, {
			filePath: yjsPath(workdir, writer.ydoc.guid),
		});
		writer.encryption.applyKeys(testEncryptionKeys);
		writer.actions.entries.create({ title: 'encrypted row' });
		writer[Symbol.dispose]();
		await yjsLog.whenDisposed;

		using lockedSnapshot = await openFujiSnapshot({
			projectDir: workdir,
			loadOfflineEncryptionKeys: async () => null,
		});
		expect(lockedSnapshot.tables.entries.getAllValid()).toEqual([]);

		using unlockedSnapshot = await openFujiSnapshot({
			projectDir: workdir,
			loadOfflineEncryptionKeys: async () => testEncryptionKeys,
		});

		expect(
			unlockedSnapshot.tables.entries.getAllValid().map((row) => row.title),
		).toEqual(['encrypted row']);
	});
});
