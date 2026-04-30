import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type FileId, generateFileId } from '@epicenter/filesystem';
import { type ProjectDir } from '@epicenter/workspace';
import {
	mintTestProjectDir,
	NoopWebSocket,
} from '@epicenter/workspace/test-utils';
import { openOpensidian as openOpensidianDaemon } from './daemon.js';
import { openOpensidian as openOpensidianScript } from './script.js';

let workdir: ProjectDir;

beforeEach(() => {
	workdir = mintTestProjectDir('opensidian-integration-');
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe('daemon to script handoff via Yjs log file', () => {
	test('script warm hydrates files the daemon wrote', () => {
		{
			using daemon = openOpensidianDaemon({
				getToken: async () => 'fake-token',
				peer: {
					id: 'test-daemon',
					name: 'Opensidian Daemon',
					platform: 'node',
				},
				projectDir: workdir,
				webSocketImpl: NoopWebSocket,
			});

			const now = Date.now();
			const seed: { id: FileId; name: string }[] = [
				{ id: generateFileId(), name: 'first.md' },
				{ id: generateFileId(), name: 'second.md' },
				{ id: generateFileId(), name: 'third.md' },
			];
			for (const { id, name } of seed) {
				daemon.tables.files.set({
					id,
					name,
					parentId: null,
					type: 'file',
					size: 0,
					createdAt: now,
					updatedAt: now,
					trashedAt: null,
					_v: 1 as const,
				});
			}
		}

		using script = openOpensidianScript({
			getToken: async () => 'fake-token',
			projectDir: workdir,
			webSocketImpl: NoopWebSocket,
		});
		const names = script.tables.files
			.getAllValid()
			.map((row) => row.name)
			.sort();
		expect(names).toEqual(['first.md', 'second.md', 'third.md']);
	});
});
