/**
 * Honeycrisp Sync Document Tests
 *
 * Verifies the Honeycrisp Cloud Workspace app document ids passed to the
 * shared sync URL resolver.
 *
 * Key behaviors:
 * - Honeycrisp root uses the product app document route.
 * - Note body document ids are route-safe.
 */

import { expect, test } from 'bun:test';
import type { LocalIdentity } from '@epicenter/auth';
import {
	resolveDefaultWorkspaceAppDocWsUrl,
	type DefaultCloudWorkspaceAuth,
} from '@epicenter/workspace';
import {
	HONEYCRISP_CLOUD_APP_ID,
	HONEYCRISP_ROOT_DOC_ID,
	honeycrispNoteBodyDocId,
} from './sync-docs.js';
import type { NoteId } from './workspace.js';

const localIdentity: LocalIdentity = {
	subject: 'user_1',
	keyring: [
		{
			version: 1,
			subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
	],
};

test('Honeycrisp root builds the Cloud Workspace app document route', async () => {
	await expect(
		resolveDefaultWorkspaceAppDocWsUrl({
			auth: defaultWorkspaceAuth(),
			apiUrl: 'https://api.example.com/',
			appId: HONEYCRISP_CLOUD_APP_ID,
			docId: HONEYCRISP_ROOT_DOC_ID,
		}),
	).resolves.toBe(
		'wss://api.example.com/workspaces/ws_123/apps/honeycrisp/docs/root',
	);
});

test('Honeycrisp note body doc ids are route-safe', () => {
	expect(honeycrispNoteBodyDocId('note/1' as NoteId)).toBe('note.h6e6f74652f31');
});

function defaultWorkspaceAuth(): DefaultCloudWorkspaceAuth {
	return {
		state: { status: 'signed-in', localIdentity },
		async fetch() {
			return Response.json({ defaultWorkspaceId: 'ws_123' });
		},
	};
}
