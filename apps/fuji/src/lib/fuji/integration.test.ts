import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import type { EncryptionKeys, ProjectDir } from '@epicenter/workspace';
import {
	attachYjsLog,
	createDaemonServer,
	createSessionStore,
	yjsPath,
} from '@epicenter/workspace/node';
import {
	mintTestProjectDir,
	NoopWebSocket,
} from '@epicenter/workspace/test-utils';
import { FUJI_DAEMON_ROUTE, fujiDaemon } from './daemon.js';
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
			const routeModule = fujiDaemon({
				getToken: async () => 'fake-token',
				webSocketImpl: NoopWebSocket,
			});
			using daemon = await routeModule({
				projectDir: workdir,
				route: FUJI_DAEMON_ROUTE,
			});

			for (const title of ['first', 'second', 'third']) {
				daemon.actions.entries.create({ title });
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

		const routeModule = fujiDaemon({
			getToken: async () => 'fake-token',
			webSocketImpl: NoopWebSocket,
		});
		const daemon = await routeModule({
			projectDir: workdir,
			route: FUJI_DAEMON_ROUTE,
		});
		const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
		process.env.XDG_RUNTIME_DIR = '/tmp';
		const server = createDaemonServer({
			projectDir: workdir,
			entries: [
				{
					route: FUJI_DAEMON_ROUTE,
					workspace: daemon,
				},
			],
		});
		try {
			const listening = await server.listen();
			expect(listening.error).toBeNull();
			if (listening.error !== null) return;

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
			await server.close();
			daemon[Symbol.dispose]();
			if (oldRuntimeDir === undefined) {
				delete process.env.XDG_RUNTIME_DIR;
			} else {
				process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
			}
		}
	});

	test('script snapshot loads saved session keys for encrypted log rows', async () => {
		const writer = openFujiDoc();
		const yjsLog = attachYjsLog(writer.ydoc, {
			filePath: yjsPath(workdir, writer.ydoc.guid),
		});
		writer.encryption.applyKeys(testEncryptionKeys);
		writer.actions.entries.create({ title: 'encrypted row' });
		writer[Symbol.dispose]();
		await yjsLog.whenDisposed;

		using lockedSnapshot = await openFujiSnapshot({ projectDir: workdir });
		expect(lockedSnapshot.tables.entries.getAllValid()).toEqual([]);

		await createSessionStore().save(
			EPICENTER_API_URL,
			{ access_token: 'fake-token', expires_in: 3600 },
			{
				encryptionKeys: testEncryptionKeys,
				user: { id: 'user-1', email: 'user@example.com' },
			},
		);
		using unlockedSnapshot = await openFujiSnapshot({ projectDir: workdir });

		expect(
			unlockedSnapshot.tables.entries.getAllValid().map((row) => row.title),
		).toEqual(['encrypted row']);
	});
});
