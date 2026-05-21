/**
 * Fuji Sync Document Tests
 *
 * Verifies the Fuji Cloud Workspace app document ids passed to the shared
 * sync URL resolver.
 *
 * Key behaviors:
 * - Fuji root uses the product app document route.
 * - Entry content document ids are route-safe.
 */

import { expect, test } from 'bun:test';
import type { LocalIdentity } from '@epicenter/auth';
import {
	resolveDefaultWorkspaceAppDocWsUrl,
	type DefaultCloudWorkspaceAuth,
} from '@epicenter/workspace';
import {
	FUJI_CLOUD_APP_ID,
	FUJI_ROOT_DOC_ID,
	fujiEntryContentDocId,
} from './sync-docs.js';
import type { EntryId } from './workspace.js';

const localIdentity: LocalIdentity = {
	subject: 'user_1',
	keyring: [
		{
			version: 1,
			subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
	],
};

test('Fuji root builds the Cloud Workspace app document route', async () => {
	await expect(
		resolveDefaultWorkspaceAppDocWsUrl({
			auth: defaultWorkspaceAuth(),
			apiUrl: 'https://api.example.com/',
			appId: FUJI_CLOUD_APP_ID,
			docId: FUJI_ROOT_DOC_ID,
		}),
	).resolves.toBe('wss://api.example.com/workspaces/ws_123/apps/fuji/docs/root');
});

test('Fuji entry content doc ids are route-safe', () => {
	expect(fujiEntryContentDocId('entry/1' as EntryId)).toBe('entry.h656e7472792f31');
});

function defaultWorkspaceAuth(): DefaultCloudWorkspaceAuth {
	return {
		state: { status: 'signed-in', localIdentity },
		async fetch() {
			return Response.json({ defaultWorkspaceId: 'ws_123' });
		},
	};
}
