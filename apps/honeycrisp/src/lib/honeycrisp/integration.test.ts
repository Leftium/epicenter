import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { AuthClient } from '@epicenter/auth';
import { DateTimeString, type ProjectDir } from '@epicenter/workspace';
import type { DaemonRuntime } from '@epicenter/workspace/daemon';
import {
	mintTestProjectDir,
	NoopWebSocket,
} from '@epicenter/workspace/test-utils';
import type { NoteId } from '../workspace.js';
import {
	DEFAULT_HONEYCRISP_DAEMON_ROUTE,
	defineHoneycrispDaemon,
} from './daemon.js';
import { openHoneycrisp as openHoneycrispDoc } from './index.js';
import { openHoneycrisp as openHoneycrispScript } from './script.js';

let workdir: ProjectDir;

beforeEach(() => {
	workdir = mintTestProjectDir('honeycrisp-integration-');
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
	test('script warm hydrates notes the daemon wrote', async () => {
		{
			const routeDefinition = defineHoneycrispDaemon({
				auth: createTestAuth(),
				peer: {
					id: 'test-daemon',
					name: 'Honeycrisp Daemon',
					platform: 'node',
				},
				webSocketImpl: NoopWebSocket,
			});
			const daemon = (await routeDefinition.start({
				projectDir: workdir,
				route: DEFAULT_HONEYCRISP_DAEMON_ROUTE,
			})) as ReturnType<typeof openHoneycrispDoc> & DaemonRuntime;

			try {
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
			} finally {
				await daemon[Symbol.asyncDispose]();
			}
		}

		using script = openHoneycrispScript({
			auth: createTestAuth(),
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
