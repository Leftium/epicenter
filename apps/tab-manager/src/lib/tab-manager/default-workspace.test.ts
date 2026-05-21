/**
 * Tab Manager Default Workspace Tests
 *
 * Verifies that Tab Manager resolves the product Workspace from `/api/workspaces`
 * at signed-in payload build time, not once during module readiness.
 *
 * Key behaviors:
 * - Signed-out resolution does not call the Workspace API.
 * - A later signed-in resolution replaces the missing value with the server default.
 */

import type { AuthState, SubjectIdentity } from '@epicenter/auth';
import { expect, test } from 'bun:test';
import { createDefaultWorkspaceIdResolver } from './default-workspace.js';

const localIdentity: SubjectIdentity = {
	subject: 'user_1',
	keyring: [
		{
			version: 1,
			subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
	],
};

test('default Workspace resolution retries after signed-out startup', async () => {
	let state: AuthState = { status: 'signed-out' };
	const fetches: string[] = [];
	const resolver = createDefaultWorkspaceIdResolver({
		get state() {
			return state;
		},
		async fetch(input) {
			fetches.push(String(input));
			return Response.json({ defaultWorkspaceId: 'ws_after_sign_in' });
		},
	});

	await resolver.resolve();

	expect(resolver.value).toBeUndefined();
	expect(fetches).toEqual([]);

	state = {
		status: 'signed-in',
		localIdentity,
	};

	await resolver.resolve();

	expect(fetches).toEqual(['/api/workspaces']);
	expect(resolver.value).toBe('ws_after_sign_in');
});
