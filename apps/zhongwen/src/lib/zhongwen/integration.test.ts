import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { AuthClient } from '@epicenter/auth';
import type { ProjectDir } from '@epicenter/workspace';
import type { DaemonRuntime } from '@epicenter/workspace/daemon';
import {
	mintTestProjectDir,
	NoopWebSocket,
} from '@epicenter/workspace/test-utils';
import {
	type ConversationId,
	generateConversationId,
} from '../workspace/definition.js';
import {
	DEFAULT_ZHONGWEN_DAEMON_ROUTE,
	defineZhongwenDaemon,
} from './daemon.js';
import { openZhongwen as openZhongwenDoc } from './index.js';
import { openZhongwen as openZhongwenScript } from './script.js';

let workdir: ProjectDir;

beforeEach(() => {
	workdir = mintTestProjectDir('zhongwen-integration-');
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

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
				encryptionKeys: [{ version: 1, userKeyBase64: 'key' }],
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
		async signInWithIdToken() {
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

describe('daemon to script handoff via Yjs log file', () => {
	test('script warm hydrates conversations the daemon wrote', async () => {
		{
			const routeDefinition = defineZhongwenDaemon({
				auth: createTestAuth(),
				peer: {
					id: 'test-daemon',
					name: 'Zhongwen Daemon',
					platform: 'node',
				},
				webSocketImpl: NoopWebSocket,
			});
			const daemon = (await routeDefinition.start({
				projectDir: workdir,
				route: DEFAULT_ZHONGWEN_DAEMON_ROUTE,
			})) as ReturnType<typeof openZhongwenDoc> & DaemonRuntime;

			try {
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
			} finally {
				await daemon[Symbol.asyncDispose]();
			}
		}

		using script = openZhongwenScript({
			auth: createTestAuth(),
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
