import { describe, expect, test } from 'bun:test';
import { findPeer, type AwarenessState } from './find-peer';

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
		expect(findPeer('42', peers)).toEqual({ kind: 'found', clientID: 42 });
	});

	test('numeric miss is not-found — no fuzzy fallback', () => {
		const peers = peersOf([[42, { deviceName: 'myMacbook' }]]);
		expect(findPeer('99', peers)).toEqual({ kind: 'not-found' });
	});

	test('numeric mode ignores deviceName that happens to equal the number', () => {
		const peers = peersOf([[55, { deviceName: '42' }]]);
		// "42" still routes to clientID mode — spec edge case
		expect(findPeer('42', peers)).toEqual({ kind: 'not-found' });
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
		});
	});

	test('escape hatch: numeric deviceName via deviceName=42', () => {
		const peers = peersOf([[55, { deviceName: '42' }]]);
		expect(findPeer('deviceName=42', peers)).toEqual({
			kind: 'found',
			clientID: 55,
		});
	});

	test('splits on first = — value may contain more equals signs', () => {
		const peers = peersOf([[7, { key: 'val=with=equals' }]]);
		expect(findPeer('key=val=with=equals', peers)).toEqual({
			kind: 'found',
			clientID: 7,
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

describe('findPeer — bare deviceName mode', () => {
	test('exact match', () => {
		const peers = peersOf([[42, { deviceName: 'myMacbook' }]]);
		expect(findPeer('myMacbook', peers)).toEqual({
			kind: 'found',
			clientID: 42,
		});
	});

	test('case-insensitive unique match → case-suggest', () => {
		const peers = peersOf([
			[42, { deviceName: 'myMacbook' }],
			[188, { deviceName: 'workLaptop' }],
		]);
		expect(findPeer('mymacbook', peers)).toEqual({
			kind: 'case-suggest',
			actual: 'myMacbook',
			clientID: 42,
		});
	});

	test('case-insensitive multiple matches → case-ambiguous (sorted ASC)', () => {
		const peers = peersOf([
			[188, { deviceName: 'workMacbook' }],
			[42, { deviceName: 'myMacbook' }],
		]);
		const result = findPeer('MACBOOK', peers);
		expect(result).toEqual({
			kind: 'case-ambiguous',
			matches: [
				{ value: 'myMacbook', clientID: 42 },
				{ value: 'workMacbook', clientID: 188 },
			],
		});
	});

	test('no match → not-found', () => {
		const peers = peersOf([[42, { deviceName: 'myMacbook' }]]);
		expect(findPeer('ghost', peers)).toEqual({ kind: 'not-found' });
	});

	test('peers without deviceName field are skipped', () => {
		const peers = peersOf([
			[42, { role: 'dev' }],
			[188, { deviceName: 'workLaptop' }],
		]);
		expect(findPeer('workLaptop', peers)).toEqual({
			kind: 'found',
			clientID: 188,
		});
	});

	test('non-string field values are skipped', () => {
		const peers = peersOf([
			[42, { deviceName: { nested: 'thing' } as unknown as string }],
			[188, { deviceName: 'workLaptop' }],
		]);
		expect(findPeer('nested', peers)).toEqual({ kind: 'not-found' });
	});
});
