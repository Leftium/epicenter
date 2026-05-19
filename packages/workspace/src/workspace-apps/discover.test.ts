/**
 * Tests for config-routed daemon extension registration.
 */

import { describe, expect, test } from 'bun:test';

import { expectErr, expectOk } from '@epicenter/test-utils/result';

import type { DaemonWorkspaceModule } from '../daemon/define-daemon-workspace.js';
import { discoverWorkspaceApps } from './discover.js';

function route(name: string): DaemonWorkspaceModule {
	return {
		route: name,
		open: () => {
			throw new Error('test route should not open');
		},
	};
}

describe('discoverWorkspaceApps', () => {
	test('returns an empty list when the config declares no routes', () => {
		const result = discoverWorkspaceApps();
		const data = expectOk(result);
		expect(data).toEqual([]);
	});

	test('turns config routes into startup entries', () => {
		const fuji = route('fuji');
		const opensidian = route('opensidian');

		const result = discoverWorkspaceApps([fuji, opensidian]);
		const data = expectOk(result);
		expect(data).toEqual([
			{
				route: 'fuji',
				module: fuji,
			},
			{
				route: 'opensidian',
				module: opensidian,
			},
		]);
	});

	test('rejects invalid route names', () => {
		const result = discoverWorkspaceApps([route('__proto__')]);
		const error = expectErr(result);
		expect(error).toMatchObject({
			name: 'WorkspaceRouteRejected',
			route: '__proto__',
			reason: 'invalid',
		});
	});

	test('rejects duplicate route names', () => {
		const result = discoverWorkspaceApps([route('fuji'), route('fuji')]);
		const error = expectErr(result);
		expect(error).toMatchObject({
			name: 'WorkspaceRouteRejected',
			route: 'fuji',
			reason: 'duplicate',
		});
	});
});
