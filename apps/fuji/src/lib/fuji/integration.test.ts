import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { ProjectDir } from '@epicenter/workspace';
import {
	mintTestProjectDir,
	NoopWebSocket,
} from '@epicenter/workspace/test-utils';
import { createDaemonServer } from '@epicenter/workspace/node';
import { defineFujiDaemon } from './daemon.js';
import { openFujiScript, openFujiSnapshot } from './script.js';

let workdir: ProjectDir;

beforeEach(() => {
	workdir = mintTestProjectDir('fuji-integration-');
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe('daemon to script handoff via Yjs log file', () => {
	test('script warm hydrates entries the daemon wrote', async () => {
		{
			const daemonDefinition = defineFujiDaemon({
				getToken: async () => 'fake-token',
				webSocketImpl: NoopWebSocket,
			});
			using daemon = await daemonDefinition.start({
				projectDir: workdir,
				configDir: workdir,
			});

			for (const title of ['first', 'second', 'third']) {
				daemon.actions.entries.create({ title });
			}
		}

		using script = openFujiSnapshot({
			projectDir: workdir,
		});
		const titles = script.tables.entries
			.getAllValid()
			.map((row) => row.title)
			.sort();
		expect(titles).toEqual(['first', 'second', 'third']);
	});

	test('script tables read and write through the daemon', async () => {
		await Bun.write(`${workdir}/epicenter.config.ts`, 'export default {};');

		const daemonDefinition = defineFujiDaemon({
			getToken: async () => 'fake-token',
			webSocketImpl: NoopWebSocket,
		});
		const daemon = await daemonDefinition.start({
			projectDir: workdir,
			configDir: workdir,
		});
		const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
		process.env.XDG_RUNTIME_DIR = '/tmp';
		const server = createDaemonServer({
			projectDir: workdir,
			workspaces: [{ route: daemonDefinition.route, workspace: daemon }],
		});
		try {
			const listening = await server.listen();
			expect(listening.error).toBeNull();
			if (listening.error !== null) return;

			await using script = await openFujiScript({ projectDir: workdir });
			const created = await script.tables.entries.create({
				title: 'daemon backed',
			});
			await script.tables.entries.update(created.id, { tags: ['script'] });

			const fresh = await script.tables.entries.getAllValid();
			expect(fresh.map((row) => row.title)).toContain('daemon backed');
			expect(fresh.find((row) => row.id === created.id)?.tags).toEqual([
				'script',
			]);

			const snapshot = openFujiSnapshot({ projectDir: workdir });
			using _snapshot = snapshot;
			expect(
				snapshot.tables.entries
					.getAllValid()
					.some((row) => row.id === created.id),
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
});
