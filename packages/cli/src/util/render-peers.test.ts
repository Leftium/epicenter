import { describe, expect, test } from 'bun:test';
import {
	buildPeerRows,
	renderPeers,
	type RenderSink,
	type WorkspacePeers,
} from './render-peers';

function recorder(): RenderSink & {
	logs: string[];
	tables: unknown[][];
} {
	const logs: string[] = [];
	const tables: unknown[][] = [];
	return {
		logs,
		tables,
		log: (m) => logs.push(m),
		table: (rows) => tables.push(rows as unknown[]),
	};
}

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

describe('renderPeers', () => {
	const workspaceA: WorkspacePeers = {
		name: 'tabManager',
		peers: new Map([
			[42, { deviceName: 'myMacbook', version: '1.5.0' }],
			[188, { deviceName: 'workLaptop', version: '1.5.0' }],
		]),
	};
	const workspaceB: WorkspacePeers = {
		name: 'whispering',
		peers: new Map([[55, { deviceName: 'myMacbook' }]]),
	};

	test('prints header per workspace and one table each', () => {
		const sink = recorder();
		renderPeers([workspaceA, workspaceB], { sink });
		expect(sink.logs).toEqual(['tabManager', '', 'whispering']);
		expect(sink.tables).toHaveLength(2);
		expect(sink.tables[0]!.length).toBe(2);
		expect(sink.tables[1]!.length).toBe(1);
	});

	test('elideHeader suppresses workspace name', () => {
		const sink = recorder();
		renderPeers([workspaceA], { elideHeader: true, sink });
		expect(sink.logs).toEqual([]);
		expect(sink.tables).toHaveLength(1);
	});

	test('prints "no peers connected" when nothing connects', () => {
		const sink = recorder();
		renderPeers(
			[{ name: 'tabManager', peers: new Map() }],
			{ sink },
		);
		expect(sink.logs).toEqual(['no peers connected']);
		expect(sink.tables).toEqual([]);
	});

	test('skips workspaces with no peers but shows others', () => {
		const sink = recorder();
		renderPeers(
			[{ name: 'tabManager', peers: new Map() }, workspaceB],
			{ sink },
		);
		expect(sink.logs).toEqual(['whispering']);
		expect(sink.tables).toHaveLength(1);
	});
});
