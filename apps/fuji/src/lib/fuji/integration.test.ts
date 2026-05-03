/**
 * Fuji Node Integration Tests
 *
 * Verifies Fuji-specific Node behavior that is not already covered by the
 * workspace Yjs log tests.
 *
 * Key behaviors:
 * - Script actions call daemon actions through RPC
 * - Offline keys unlock encrypted log rows
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { EncryptionKeys } from '@epicenter/encryption';
import type { ProjectDir } from '@epicenter/workspace';
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
import { FUJI_WORKSPACE_ID, openFuji as openFujiDoc } from './index.js';
import { openFujiScript, openFujiSnapshot } from './script.js';

let workdir: ProjectDir;
let oldEpicenterHome: string | undefined;
let oldSecrets: typeof Bun.secrets;
let oldWebSocket: typeof globalThis.WebSocket | undefined;

const testEncryptionKeys: EncryptionKeys = [
	{
		version: 1,
		userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
];

beforeEach(() => {
	workdir = mintTestProjectDir('fuji-integration-');
	oldEpicenterHome = Bun.env.EPICENTER_HOME;
	Bun.env.EPICENTER_HOME = `${workdir}/home`;
	oldSecrets = Bun.secrets;
	Bun.secrets = {
		async get() {
			return null;
		},
		async set() {},
		async delete() {},
	};
	oldWebSocket = globalThis.WebSocket;
	globalThis.WebSocket =
		NoopWebSocket as unknown as typeof globalThis.WebSocket;
});

afterEach(() => {
	if (oldWebSocket === undefined) {
		delete (globalThis as { WebSocket?: typeof globalThis.WebSocket })
			.WebSocket;
	} else {
		globalThis.WebSocket = oldWebSocket;
	}
	if (oldEpicenterHome === undefined) {
		delete Bun.env.EPICENTER_HOME;
	} else {
		Bun.env.EPICENTER_HOME = oldEpicenterHome;
	}
	Bun.secrets = oldSecrets;
	rmSync(workdir, { recursive: true, force: true });
});

describe('Fuji node surfaces', () => {
	test('script actions read and write through the daemon', async () => {
		await Bun.write(`${workdir}/epicenter.config.ts`, 'export default {};');

		const routeDefinition = defineFujiDaemon();
		const daemon = await routeDefinition.start({
			projectDir: workdir,
			route: DEFAULT_FUJI_DAEMON_ROUTE,
		});
		const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
		let lease: DaemonLease | null = null;
		let server: DaemonServer | null = null;
		try {
			process.env.XDG_RUNTIME_DIR = '/private/tmp';
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
			filePath: yjsPath(workdir, FUJI_WORKSPACE_ID),
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
