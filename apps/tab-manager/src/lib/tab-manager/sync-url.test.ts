/**
 * Tab Manager Sync URL Tests
 *
 * Verifies the extension's default Cloud sync route and the absent sync URL
 * used when no default Cloud Workspace is available.
 *
 * Key behaviors:
 * - Known default Workspace opens the Tab Manager root app doc.
 * - Missing default Workspace returns no Cloud sync URL.
 */

import { describe, expect, test } from 'bun:test';
import { tabManagerSyncUrl } from './sync-url.js';

describe('tabManagerSyncUrl', () => {
	test('uses the default Cloud Workspace app root document route', () => {
		expect(
			tabManagerSyncUrl({
				apiUrl: 'https://api.example.com/',
				defaultWorkspaceId: 'ws_123',
			}),
		).toBe(
			'wss://api.example.com/workspaces/ws_123/apps/tab-manager/docs/root',
		);
	});

	test('returns no Cloud sync URL without a default Workspace', () => {
		expect(
			tabManagerSyncUrl({
				apiUrl: 'https://api.example.com/',
			}),
		).toBeUndefined();
	});
});
