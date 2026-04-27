import { describe, expect, test } from 'bun:test';
import { buildPeerRows } from './peers';

describe('buildPeerRows', () => {
	test('projects device.{id,name,platform} to flat columns; clientID first', () => {
		const rows = buildPeerRows(
			new Map([
				[
					42,
					{
						device: {
							id: '0xabc',
							name: 'myMacbook',
							platform: 'tauri',
						},
					},
				],
			]),
		);
		expect(rows).toHaveLength(1);
		expect(Object.keys(rows[0]!)).toEqual([
			'clientID',
			'deviceId',
			'name',
			'platform',
		]);
		expect(rows[0]).toEqual({
			clientID: 42,
			deviceId: '0xabc',
			name: 'myMacbook',
			platform: 'tauri',
		});
	});

	test('rows are sorted by clientID ASC', () => {
		const rows = buildPeerRows(
			new Map([
				[203, { device: { id: 'p', name: 'phone', platform: 'web' } }],
				[42, { device: { id: 'm', name: 'mac', platform: 'tauri' } }],
				[188, { device: { id: 'w', name: 'work', platform: 'web' } }],
			]),
		);
		expect(rows.map((r) => r.clientID)).toEqual([42, 188, 203]);
	});

	test('empty map yields empty row list', () => {
		expect(buildPeerRows(new Map())).toEqual([]);
	});
});
