import { describe, expect, test } from 'bun:test';

describe('@napi-rs/keyring dynamic import', () => {
	test('loads the native package without a static import', async () => {
		const mod = await import('@napi-rs/keyring');
		expect(typeof mod.Entry).toBe('function');
		const entry = new mod.Entry('epicenter.auth.smoke', 'dynamic-import');
		expect(entry).toBeDefined();
	});
});
