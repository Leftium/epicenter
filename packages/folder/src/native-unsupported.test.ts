/**
 * Native Unsupported-Platform Tests
 *
 * A Bun directory folder on a platform with no exchange, Windows among them,
 * simulated by setting `process.platform` to `win32` before any module of the
 * folder loads. A replacement there must find its file in place when it
 * lands, and nothing here can make it so, so it is refused rather than
 * published another way.
 *
 * Key behaviors:
 * - A guarded replacement of an existing file is `Io`, names the platform,
 *   and says nothing was written; it returns no success
 * - The file keeps its bytes, nothing is renamed onto it, and the staged copy
 *   is removed
 *
 * See also:
 * - `native-publication.test.ts` for replacements where the exchange exists
 */
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs/promises';
import { join, sep } from 'node:path';

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
Object.defineProperty(process, 'platform', {
	value: 'win32',
	configurable: true,
});
afterAll(() => {
	if (platform !== undefined)
		Object.defineProperty(process, 'platform', platform);
});

const real = { ...realFs };
const SCRATCH = `${sep}.git${sep}epicenter${sep}scratch${sep}`;
/** Destinations of every rename of a staged file. */
const renamedOnto: string[] = [];

mock.module('node:fs/promises', () => ({
	...real,
	default: real,
	async rename(...args: Parameters<typeof real.rename>) {
		if (String(args[0]).includes(SCRATCH)) renamedOnto.push(String(args[1]));
		return real.rename(...args);
	},
}));

// Loaded only now, so every module sees the simulated platform.
const { expectErr } = await import('wellcrafted/testing');
const { hashBytes } = await import('./capture.js');
const { scratch } = await import('./git-http.test-support.js');
const { exchangeSupported } = await import('./native-exchange.js');
const { createNativeFileBoundary } = await import('./native-store.js');

const encoder = new TextEncoder();
const roots: string[] = [];
afterEach(async () => {
	renamedOnto.length = 0;
	for (const root of roots.splice(0))
		await real.rm(root, { recursive: true, force: true });
});

test('a replacement on a platform with no exchange is refused, and nothing is written', async () => {
	expect(exchangeSupported).toBe(false);
	const folder = await real.realpath(await scratch('native-unsupported-'));
	roots.push(folder);
	await real.writeFile(join(folder, 'note.md'), 'read');
	const boundary = createNativeFileBoundary(folder);
	const bytes = encoder.encode('mine');

	const refused = expectErr(
		await boundary.apply([
			{
				kind: 'replace',
				path: 'note.md',
				bytes,
				sha256: await hashBytes(bytes),
				expectedSha256: await hashBytes(encoder.encode('read')),
			},
		]),
	);

	expect(refused.name).toBe('Io');
	expect(refused.message).toContain('not available on win32');
	expect(refused.message).toContain('Nothing was written');
	expect(await real.readFile(join(folder, 'note.md'), 'utf8')).toBe('read');
	expect(renamedOnto).toEqual([]);
	expect(
		await real.readdir(join(folder, '.git', 'epicenter', 'scratch')),
	).toEqual([]);
});
