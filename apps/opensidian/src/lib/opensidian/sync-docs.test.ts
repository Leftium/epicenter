/**
 * Opensidian Sync Document Tests
 *
 * Verifies the Opensidian Cloud Workspace app document ids passed to the
 * shared sync URL resolver.
 *
 * Key behaviors:
 * - Opensidian root uses the product app document route.
 */

import { expect, test } from 'bun:test';
import type { LocalIdentity } from '@epicenter/auth';
import {
	resolveDefaultWorkspaceAppDocWsUrl,
	type DefaultCloudWorkspaceAuth,
} from '@epicenter/workspace';
import {
	OPENSIDIAN_CLOUD_APP_ID,
	OPENSIDIAN_ROOT_DOC_ID,
} from './sync-docs.js';

const localIdentity: LocalIdentity = {
	subject: 'user_1',
	keyring: [
		{
			version: 1,
			subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
	],
};

test('Opensidian root builds the Cloud Workspace app document route', async () => {
	await expect(
		resolveDefaultWorkspaceAppDocWsUrl({
			auth: defaultWorkspaceAuth(),
			apiUrl: 'https://api.example.com/',
			appId: OPENSIDIAN_CLOUD_APP_ID,
			docId: OPENSIDIAN_ROOT_DOC_ID,
		}),
	).resolves.toBe(
		'wss://api.example.com/workspaces/ws_123/apps/opensidian/docs/root',
	);
});

function defaultWorkspaceAuth(): DefaultCloudWorkspaceAuth {
	return {
		state: { status: 'signed-in', localIdentity },
		async fetch() {
			return Response.json({ defaultWorkspaceId: 'ws_123' });
		},
	};
}
