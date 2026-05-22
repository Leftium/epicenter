/**
 * Sync Transport URL Tests
 *
 * Verifies hosted sync URL construction for the daemon room route and the
 * default-workspace app document route.
 *
 * Key behaviors:
 * - Room URLs stay available for the daemon path.
 * - Default-workspace app doc URLs use `/me/apps/:appId/docs/:docId`; the
 *   server resolves the workspaceId from the auth token.
 * - Route identity segments are encoded independently.
 */

import { describe, expect, test } from 'bun:test';
import { defaultWorkspaceAppDocWsUrl, roomWsUrl } from './transport.js';

describe('roomWsUrl', () => {
	test('keeps the daemon /rooms route encoded', () => {
		expect(roomWsUrl('https://api.example.com/', 'a/b?c#d')).toBe(
			'wss://api.example.com/rooms/a%2Fb%3Fc%23d',
		);
	});
});

describe('defaultWorkspaceAppDocWsUrl', () => {
	test('builds the default-workspace app doc WebSocket route', () => {
		expect(
			defaultWorkspaceAppDocWsUrl('https://api.example.com', {
				appId: 'tab-manager',
				docId: 'root',
			}),
		).toBe('wss://api.example.com/me/apps/tab-manager/docs/root');
	});

	test('converts http origins to ws and https origins to wss', () => {
		expect(
			defaultWorkspaceAppDocWsUrl('http://localhost:8787', {
				appId: 'honeycrisp',
				docId: 'root',
			}),
		).toBe('ws://localhost:8787/me/apps/honeycrisp/docs/root');
	});

	test('strips trailing slashes from the apiUrl', () => {
		expect(
			defaultWorkspaceAppDocWsUrl('https://api.example.com///', {
				appId: 'fuji',
				docId: 'root',
			}),
		).toBe('wss://api.example.com/me/apps/fuji/docs/root');
	});

	test('encodes every route identity segment independently', () => {
		expect(
			defaultWorkspaceAppDocWsUrl('http://localhost:8787', {
				appId: 'app?b',
				docId: 'doc#c',
			}),
		).toBe('ws://localhost:8787/me/apps/app%3Fb/docs/doc%23c');
	});
});
