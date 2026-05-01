import { describe, expect, test } from 'bun:test';
import { normalizeServerOrigin } from './server-origin.ts';

describe('normalizeServerOrigin', () => {
	test('normalizes origins and maps websocket schemes', () => {
		expect(normalizeServerOrigin('https://api.epicenter.so/')).toBe(
			'https://api.epicenter.so',
		);
		expect(normalizeServerOrigin('wss://api.epicenter.so')).toBe(
			'https://api.epicenter.so',
		);
		expect(normalizeServerOrigin('ws://localhost:8787')).toBe(
			'http://localhost:8787',
		);
	});

	test('rejects path, search, and hash', () => {
		expect(() => normalizeServerOrigin('https://api.epicenter.so/auth')).toThrow();
		expect(() =>
			normalizeServerOrigin('https://api.epicenter.so?x=1'),
		).toThrow();
		expect(() =>
			normalizeServerOrigin('https://api.epicenter.so#auth'),
		).toThrow();
	});
});
