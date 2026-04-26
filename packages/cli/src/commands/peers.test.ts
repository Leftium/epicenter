import { describe, expect, test } from 'bun:test';
import { buildPeerRows } from './peers';

describe('buildPeerRows', () => {
	test('clientID is the first column; remaining keys are alphabetical', () => {
		const rows = buildPeerRows(
			new Map([
				[42, { version: '1.5.0', deviceName: 'myMacbook', activeTabCount: 12 }],
			]),
		);
		expect(rows).toHaveLength(1);
		expect(Object.keys(rows[0]!)).toEqual([
			'clientID',
			'activeTabCount',
			'deviceName',
			'version',
		]);
	});

	test('rows are sorted by clientID ASC', () => {
		const rows = buildPeerRows(
			new Map([
				[203, { deviceName: 'phone' }],
				[42, { deviceName: 'myMacbook' }],
				[188, { deviceName: 'workLaptop' }],
			]),
		);
		expect(rows.map((r) => r.clientID)).toEqual([42, 188, 203]);
	});

	test('missing fields render as blank string across the union of keys', () => {
		const rows = buildPeerRows(
			new Map([
				[42, { deviceName: 'myMacbook', version: '1.5.0' }],
				[188, { deviceName: 'workLaptop' }],
			]),
		);
		expect(rows[1]).toEqual({
			clientID: 188,
			deviceName: 'workLaptop',
			version: '',
		});
	});

	test('empty map yields empty row list', () => {
		expect(buildPeerRows(new Map())).toEqual([]);
	});
});
