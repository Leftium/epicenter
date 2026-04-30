import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { type ProjectDir } from '@epicenter/workspace';
import {
	mintTestProjectDir,
	NoopWebSocket,
} from '@epicenter/workspace/test-utils';
import {
	type ConversationId,
	generateConversationId,
} from '../workspace/definition.js';
import { openZhongwen as openZhongwenDaemon } from './daemon.js';
import { openZhongwen as openZhongwenScript } from './script.js';

let workdir: ProjectDir;

beforeEach(() => {
	workdir = mintTestProjectDir('zhongwen-integration-');
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe('daemon to script handoff via Yjs log file', () => {
	test('script warm hydrates conversations the daemon wrote', () => {
		{
			using daemon = openZhongwenDaemon({
				getToken: async () => 'fake-token',
				peer: {
					id: 'test-daemon',
					name: 'Zhongwen Daemon',
					platform: 'node',
				},
				projectDir: workdir,
				webSocketImpl: NoopWebSocket,
			});

			const now = Date.now();
			const seed: { id: ConversationId; title: string }[] = [
				{ id: generateConversationId(), title: 'first' },
				{ id: generateConversationId(), title: 'second' },
				{ id: generateConversationId(), title: 'third' },
			];
			for (const { id, title } of seed) {
				daemon.tables.conversations.set({
					id,
					title,
					provider: 'openai',
					model: 'gpt-4',
					createdAt: now,
					updatedAt: now,
					_v: 1 as const,
				});
			}
		}

		using script = openZhongwenScript({
			getToken: async () => 'fake-token',
			projectDir: workdir,
			webSocketImpl: NoopWebSocket,
		});
		const titles = script.tables.conversations
			.getAllValid()
			.map((row) => row.title)
			.sort();
		expect(titles).toEqual(['first', 'second', 'third']);
	});
});
