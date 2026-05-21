/**
 * Cloud Workspace Sync Tests
 *
 * Verifies shared resolution of the default Cloud Workspace app document route.
 *
 * Key behaviors:
 * - Signed-out and reauth-required auth states do not call the Workspace API.
 * - Failed or malformed Workspace API responses return no URL.
 * - A string default Workspace id builds an encoded app document URL.
 */

import { describe, expect, test } from 'bun:test';
import type { AuthState, LocalIdentity } from '@epicenter/auth';
import {
	resolveDefaultCloudWorkspaceId,
	resolveDefaultWorkspaceAppDocWsUrl,
	routeSafeWorkspaceAppDocId,
	type DefaultCloudWorkspaceAuth,
} from './cloud-workspace-sync.js';

const localIdentity: LocalIdentity = {
	subject: 'user_1',
	keyring: [
		{
			version: 1,
			subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
	],
};

function authHarness({
	state = { status: 'signed-in', localIdentity },
	response = Response.json({ defaultWorkspaceId: 'ws_123' }),
	throwOnFetch = false,
}: {
	state?: AuthState;
	response?: Response;
	throwOnFetch?: boolean;
} = {}) {
	const fetches: string[] = [];
	const auth: DefaultCloudWorkspaceAuth = {
		state,
		async fetch(input: Request | string | URL) {
			fetches.push(String(input));
			if (throwOnFetch) throw new Error('offline');
			return response;
		},
	};
	return { auth, fetches };
}

describe('resolveDefaultCloudWorkspaceId', () => {
	test('signed out returns undefined without fetching', async () => {
		const { auth, fetches } = authHarness({ state: { status: 'signed-out' } });

		await expect(resolveDefaultCloudWorkspaceId(auth)).resolves.toBeUndefined();
		expect(fetches).toEqual([]);
	});

	test('reauth-required returns undefined without fetching', async () => {
		const { auth, fetches } = authHarness({
			state: { status: 'reauth-required', localIdentity },
		});

		await expect(resolveDefaultCloudWorkspaceId(auth)).resolves.toBeUndefined();
		expect(fetches).toEqual([]);
	});

	test('offline fetch returns undefined', async () => {
		const { auth } = authHarness({ throwOnFetch: true });

		await expect(resolveDefaultCloudWorkspaceId(auth)).resolves.toBeUndefined();
	});

	test('/api/workspaces non-ok returns undefined', async () => {
		const { auth } = authHarness({
			response: new Response(null, { status: 500 }),
		});

		await expect(resolveDefaultCloudWorkspaceId(auth)).resolves.toBeUndefined();
	});

	test('missing defaultWorkspaceId returns undefined', async () => {
		const { auth } = authHarness({ response: Response.json({}) });

		await expect(resolveDefaultCloudWorkspaceId(auth)).resolves.toBeUndefined();
	});
});

describe('resolveDefaultWorkspaceAppDocWsUrl', () => {
	test('string defaultWorkspaceId returns a workspace app doc URL', async () => {
		const { auth, fetches } = authHarness();

		await expect(
			resolveDefaultWorkspaceAppDocWsUrl({
				auth,
				apiUrl: 'https://api.example.com/',
				appId: 'fuji',
				docId: 'root',
			}),
		).resolves.toBe('wss://api.example.com/workspaces/ws_123/apps/fuji/docs/root');
		expect(fetches).toEqual(['/api/workspaces']);
	});

	test('route ids are encoded by workspaceAppDocWsUrl', async () => {
		const { auth } = authHarness({
			response: Response.json({ defaultWorkspaceId: 'ws/a' }),
		});

		await expect(
			resolveDefaultWorkspaceAppDocWsUrl({
				auth,
				apiUrl: 'http://localhost:8787',
				appId: 'app?b',
				docId: 'doc#c',
			}),
		).resolves.toBe(
			'ws://localhost:8787/workspaces/ws%2Fa/apps/app%3Fb/docs/doc%23c',
		);
	});
});

describe('routeSafeWorkspaceAppDocId', () => {
	test('builds a route-safe stable document id from arbitrary input', () => {
		expect(routeSafeWorkspaceAppDocId({ prefix: 'entry', id: 'a/b:c' })).toBe(
			'entry.h612f623a63',
		);
	});
});
