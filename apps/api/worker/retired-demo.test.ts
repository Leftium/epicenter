/**
 * The retired anonymous tutor route cannot call a provider or touch account data.
 * Personal Zhongwen inference goes directly to Google with a device-owned key.
 */
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
mock.module('cloudflare:workers', () => ({ DurableObject: class {} }));
const entry = await import('./index.js');
const realFetch = globalThis.fetch;
afterAll(() => {
	globalThis.fetch = realFetch;
});

test('the former anonymous completion endpoint is absent and spends no house key', async () => {
	let providerCalls = 0;
	spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(
			async () => {
				providerCalls++;
				throw new Error('no provider request expected');
			},
			{ preconnect: realFetch.preconnect },
		),
	);
	let databaseReads = 0;
	const env = {
		API_PUBLIC_ORIGIN: 'https://api.epicenter.so',
		get HYPERDRIVE() {
			databaseReads++;
			throw new Error('no database expected');
		},
	};
	const response = await entry.default.fetch(
		new Request('https://api.epicenter.so/demo/v1/chat/completions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'zhongwen-tutor',
				stream: true,
				messages: [{ role: 'user', content: '你好' }],
			}),
		}),
		env as never,
		{ waitUntil() {}, passThroughOnException() {} } as never,
	);
	expect(response.status).toBe(404);
	expect(providerCalls).toBe(0);
	expect(databaseReads).toBe(0);
});
