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
							offers: { 'tabs.close': { type: 'mutation' } },
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
				[203, { device: { id: 'p', name: 'phone', platform: 'web', offers: {} } }],
				[42, { device: { id: 'm', name: 'mac', platform: 'tauri', offers: {} } }],
				[188, { device: { id: 'w', name: 'work', platform: 'web', offers: {} } }],
			]),
		);
		expect(rows.map((r) => r.clientID)).toEqual([42, 188, 203]);
	});

	test('drops the offers field even when present in awareness state', () => {
		const rows = buildPeerRows(
			new Map([
				[
					42,
					{
						device: {
							id: '0x1',
							name: 'mac',
							platform: 'tauri',
							offers: { 'tabs.close': { type: 'mutation' } },
						},
					},
				],
			]),
		);
		expect(Object.keys(rows[0]!)).not.toContain('offers');
		expect(Object.keys(rows[0]!)).not.toContain('device');
	});

	test('empty map yields empty row list', () => {
		expect(buildPeerRows(new Map())).toEqual([]);
	});
});
