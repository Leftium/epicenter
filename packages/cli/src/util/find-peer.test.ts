import { describe, expect, test } from 'bun:test';
import { findPeer } from './find-peer';
import type { AwarenessState } from './awareness';

function peersOf(
	rows: Array<[number, AwarenessState]>,
): Map<number, AwarenessState> {
	return new Map(rows);
}

describe('findPeer — numeric / clientID mode', () => {
	test('all-digits target matches clientID exactly', () => {
		const peers = peersOf([
			[42, { deviceName: 'myMacbook' }],
			[188, { deviceName: 'workLaptop' }],
		]);
		expect(findPeer('42', peers)).toEqual({
			kind: 'found',
			clientID: 42,
			state: { deviceName: 'myMacbook' },
		});
	});

	test('numeric miss is not-found — no fuzzy fallback', () => {
		const peers = peersOf([[42, { deviceName: 'myMacbook' }]]);
		expect(findPeer('99', peers)).toEqual({ kind: 'not-found' });
	});

	test('numeric target ignores string fields that happen to equal the number', () => {
		const peers = peersOf([[55, { deviceName: '42' }]]);
		// "42" always routes to clientID mode — use `--peer field=42` to match string values
		expect(findPeer('42', peers)).toEqual({ kind: 'not-found' });
	});

	test('bare non-numeric target without `=` is not-found (no default field)', () => {
		const peers = peersOf([[42, { deviceName: 'myMacbook' }]]);
		expect(findPeer('myMacbook', peers)).toEqual({ kind: 'not-found' });
	});
});

describe('findPeer — k=v explicit field mode', () => {
	test('matches by explicit field', () => {
		const peers = peersOf([
			[42, { deviceName: 'myMacbook', role: 'dev' }],
			[188, { deviceName: 'workLaptop', role: 'prod' }],
		]);
		expect(findPeer('deviceName=workLaptop', peers)).toEqual({
			kind: 'found',
			clientID: 188,
			state: { deviceName: 'workLaptop', role: 'prod' },
		});
	});

	test('escape hatch: numeric deviceName via deviceName=42', () => {
		const peers = peersOf([[55, { deviceName: '42' }]]);
		expect(findPeer('deviceName=42', peers)).toEqual({
			kind: 'found',
			clientID: 55,
			state: { deviceName: '42' },
		});
	});

	test('splits on first = — value may contain more equals signs', () => {
		const peers = peersOf([[7, { key: 'val=with=equals' }]]);
		expect(findPeer('key=val=with=equals', peers)).toEqual({
			kind: 'found',
			clientID: 7,
			state: { key: 'val=with=equals' },
		});
	});

	test('case-insensitive miss → case-suggest', () => {
		const peers = peersOf([[42, { deviceName: 'myMacbook' }]]);
		expect(findPeer('deviceName=MYMACBOOK', peers)).toEqual({
			kind: 'case-suggest',
			actual: 'myMacbook',
			clientID: 42,
		});
	});
});

describe('findPeer — k=v case-ambiguity and field hygiene', () => {
	test('case-insensitive multiple matches → case-ambiguous (sorted ASC)', () => {
		const peers = peersOf([
			[188, { deviceName: 'workMacbook' }],
			[42, { deviceName: 'myMacbook' }],
		]);
		const result = findPeer('deviceName=MACBOOK', peers);
		expect(result).toEqual({
			kind: 'case-ambiguous',
			matches: [
				{ value: 'myMacbook', clientID: 42 },
				{ value: 'workMacbook', clientID: 188 },
			],
		});
	});

	test('peers without the requested field are skipped', () => {
		const peers = peersOf([
			[42, { role: 'dev' }],
			[188, { deviceName: 'workLaptop' }],
		]);
		expect(findPeer('deviceName=workLaptop', peers)).toEqual({
			kind: 'found',
			clientID: 188,
			state: { deviceName: 'workLaptop' },
		});
	});

	test('non-string field values are skipped', () => {
		const peers = peersOf([
			[42, { deviceName: { nested: 'thing' } as unknown as string }],
			[188, { deviceName: 'workLaptop' }],
		]);
		expect(findPeer('deviceName=nested', peers)).toEqual({ kind: 'not-found' });
	});
});
