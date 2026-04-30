import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	DateTimeString,
	NoopWebSocket,
	type ProjectDir,
} from '@epicenter/workspace';
import { mintTestProjectDir } from '@epicenter/workspace/test-utils';
import { type NoteId } from '../workspace.js';
import { openHoneycrisp as openHoneycrispDaemon } from './daemon.js';
import { openHoneycrisp as openHoneycrispScript } from './script.js';

let workdir: ProjectDir;

beforeEach(() => {
	workdir = mintTestProjectDir('honeycrisp-integration-');
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe('daemon to script handoff via Yjs log file', () => {
	test('script warm hydrates notes the daemon wrote', () => {
		{
			using daemon = openHoneycrispDaemon({
				getToken: async () => 'fake-token',
				device: {
					id: 'test-daemon',
					name: 'Honeycrisp Daemon',
					platform: 'node',
				},
				projectDir: workdir,
				webSocketImpl: NoopWebSocket,
			});

			const now = DateTimeString.now();
			const seed: { id: NoteId; title: string }[] = [
				{ id: 'a' as NoteId, title: 'first' },
				{ id: 'b' as NoteId, title: 'second' },
				{ id: 'c' as NoteId, title: 'third' },
			];
			for (const { id, title } of seed) {
				daemon.tables.notes.set({
					id,
					title,
					preview: '',
					pinned: false,
					deletedAt: undefined,
					wordCount: undefined,
					createdAt: now,
					updatedAt: now,
					_v: 2 as const,
				});
			}
		}

		using script = openHoneycrispScript({
			getToken: async () => 'fake-token',
			projectDir: workdir,
			webSocketImpl: NoopWebSocket,
		});
		const titles = script.tables.notes
			.getAllValid()
			.map((row) => row.title)
			.sort();
		expect(titles).toEqual(['first', 'second', 'third']);
	});
});
