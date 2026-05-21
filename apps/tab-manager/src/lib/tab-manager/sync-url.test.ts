/**
 * Tab Manager Sync URL Tests
 *
 * Verifies the extension's default Cloud sync route and the compatibility
 * fallback used when no default Cloud Workspace is available.
 *
 * Key behaviors:
 * - Known default Workspace opens the Tab Manager root app doc.
 * - Missing default Workspace keeps the legacy room route.
 */

import { describe, expect, test } from 'bun:test';
import { tabManagerSyncUrl } from './sync-url.js';

describe('tabManagerSyncUrl', () => {
	test('uses the default Cloud Workspace app root document route', () => {
		expect(
			tabManagerSyncUrl({
				apiUrl: 'https://api.example.com/',
				roomId: 'epicenter.tab-manager',
				defaultWorkspaceId: 'ws_123',
			}),
		).toBe(
			'wss://api.example.com/workspaces/ws_123/apps/tab-manager/docs/root',
		);
	});

	test('keeps the room route as a compatibility fallback', () => {
		expect(
			tabManagerSyncUrl({
				apiUrl: 'https://api.example.com/',
				roomId: 'epicenter.tab-manager',
			}),
		).toBe('wss://api.example.com/rooms/epicenter.tab-manager');
	});
});
