/**
 * Sync Transport URL Tests
 *
 * Verifies hosted sync URL construction for the legacy room route and the
 * Cloud Workspace app document route.
 *
 * Key behaviors:
 * - Room URLs stay available for compatibility.
 * - Workspace app doc URLs use `/workspaces/:workspaceId/apps/:appId/docs/:docId`.
 * - Route identity segments are encoded independently.
 */

import { describe, expect, test } from 'bun:test';
import { roomWsUrl, workspaceAppDocWsUrl } from './transport.js';

describe('roomWsUrl', () => {
	test('keeps the compatibility /rooms route encoded', () => {
		expect(roomWsUrl('https://api.example.com/', 'a/b?c#d')).toBe(
			'wss://api.example.com/rooms/a%2Fb%3Fc%23d',
		);
	});
});

describe('workspaceAppDocWsUrl', () => {
	test('builds the Cloud Workspace app doc WebSocket route', () => {
		expect(
			workspaceAppDocWsUrl('https://api.example.com/', {
				workspaceId: 'ws_123',
				appId: 'tab-manager',
				docId: 'root',
			}),
		).toBe(
			'wss://api.example.com/workspaces/ws_123/apps/tab-manager/docs/root',
		);
	});

	test('encodes every route identity segment independently', () => {
		expect(
			workspaceAppDocWsUrl('http://localhost:8787', {
				workspaceId: 'ws/a',
				appId: 'app?b',
				docId: 'doc#c',
			}),
		).toBe('ws://localhost:8787/workspaces/ws%2Fa/apps/app%3Fb/docs/doc%23c');
	});
});
