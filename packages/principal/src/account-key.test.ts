/** Portable account directories follow ADR-0461's byte contract on every platform. */
import { expect, test } from 'bun:test';
import { accountKey, isAccountKey } from './account-key.js';
import { asPrincipalId } from './principal.js';

const key = (authorityId: string, principalId: string) =>
	accountKey({ authorityId, principalId: asPrincipalId(principalId) });

test('the ADR-0461 golden vectors pin the derivation', async () => {
	for (const [authorityId, principalId, expected] of [
		[
			'epicenter-api',
			'user-123',
			'b7efec8b3e072ff278fe2e331ce495dee36882be0ad2981c4e0196aeecbc1fc7',
		],
		[
			'instance-68747470733a2f2f6578616d706c652e74657374',
			'instance',
			'478bb60d9394294f671f2c4a5afe2819848e57243d4d319e14f5e8d1fe269653',
		],
		[
			'A',
			'é',
			'1f9770442aa6f99e1fe926643b4ba2cc764e63abaee38dcc6bb158a62c3d4720',
		],
	] as const) {
		const derived = await key(authorityId, principalId);
		expect(derived).toBe(expected);
		expect(isAccountKey(derived)).toBe(true);
	}
});

test('identities are hashed without trimming, case folding, or normalization', async () => {
	const keys = await Promise.all([
		key('a', 'b'),
		key('a', 'B'),
		key('A', 'b'),
		key('a', 'b '),
		key(' a', 'b'),
		// The length prefix keeps the component boundary in the address.
		key('ab', 'c'),
		key('a', 'bc'),
		// Precomposed and decomposed forms of one visible character stay distinct.
		key('a', 'é'),
		key('a', 'é'),
	]);
	expect(new Set(keys).size).toBe(keys.length);
});

test('empty, malformed, and control-character identities are refused', async () => {
	for (const [authorityId, principalId] of [
		['', 'user'],
		['authority', ''],
		['\ud800', 'user'],
		['authority', '\udfff'],
		['authority\n', 'user'],
		['authority', 'user\u0000'],
		['authority', 'user\u0085'],
	] as const)
		await expect(key(authorityId, principalId)).rejects.toThrow(TypeError);
});

test('only a full lowercase digest is an account key', () => {
	for (const value of [
		'',
		'b7efec8b',
		'B7EFEC8B3E072FF278FE2E331CE495DEE36882BE0AD2981C4E0196AEECBC1FC7',
		'b7efec8b3e072ff278fe2e331ce495dee36882be0ad2981c4e0196aeecbc1fc7\n',
		'../7efec8b3e072ff278fe2e331ce495dee36882be0ad2981c4e0196aeecbc1fc7',
	])
		expect(isAccountKey(value)).toBe(false);
});
