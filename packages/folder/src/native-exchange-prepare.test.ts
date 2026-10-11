/**
 * Native Exchange Preparation Tests
 *
 * A Bun directory folder loads the exchange addon `scripts/build-addon.ts`
 * prepared; it never compiles. These tests hide the addon's source or its
 * prepared build from the loader, as a broken package, a fresh checkout, or a
 * changed `addon/exchange.c` would.
 *
 * Key behaviors:
 * - A source that cannot be read is a packaging failure, not a missing file:
 *   the loader's error has no `code`, keeps the `ENOENT` as its cause, and
 *   the replacement is `Io` (never `NotFound` or `Conflict`) with the file
 *   unchanged
 * - A missing or stale build fails a replacement as `Io` before anything is
 *   written, naming the command that prepares it
 * - No failure is remembered: once the source and build are there, the next
 *   replacement in the same process lands
 */
import { afterEach, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import { readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr } from 'wellcrafted/testing';
import { hashBytes } from './capture.js';
import { scratch } from './git-http.test-support.js';

const real = { ...realFs };
/**
 * `source`: `addon/exchange.c` is gone. `missing`: no build at all. `stale`:
 * only builds of another source.
 */
let hidden: 'source' | 'missing' | 'stale' | undefined;
const isBuild = (path: unknown) => /exchange-[^/\\]+\.node$/.test(String(path));

mock.module('node:fs', () => ({
	...real,
	default: real,
	readFileSync(...args: Parameters<typeof real.readFileSync>) {
		const path = String(args[0]);
		if (hidden === 'source' && path.endsWith('exchange.c'))
			throw Object.assign(
				new Error(`ENOENT: no such file or directory, open '${path}'`),
				{ code: 'ENOENT', errno: -2, syscall: 'open', path },
			);
		return real.readFileSync(...args);
	},
	existsSync(path: realFs.PathLike) {
		if ((hidden === 'missing' || hidden === 'stale') && isBuild(path))
			return false;
		return real.existsSync(path);
	},
	readdirSync(...args: Parameters<typeof real.readdirSync>) {
		const names = real.readdirSync(...args) as unknown as string[];
		if (hidden === 'missing') return names.filter((name) => !isBuild(name));
		if (hidden === 'stale')
			return names.map((name) =>
				isBuild(name)
					? name.replace(/-[0-9a-f]{16}\.node$/, '-0000000000000000.node')
					: name,
			);
		return names;
	},
}));

const { exchangeFiles, exchangeSupported } = await import(
	'./native-exchange.js'
);
const { createNativeFileBoundary } = await import('./native-store.js');

const encoder = new TextEncoder();
const roots: string[] = [];
afterEach(async () => {
	hidden = undefined;
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function replace(text: string) {
	const bytes = encoder.encode(text);
	return {
		kind: 'replace' as const,
		path: 'note.md',
		bytes,
		sha256: await hashBytes(bytes),
		expectedSha256: await hashBytes(encoder.encode('read')),
	};
}

// One test: the first successful load is kept for the rest of the process.
test.skipIf(!exchangeSupported)(
	'an unreadable source, then a missing or stale build, are Io before anything is written, and a retry lands',
	async () => {
		const folder = await realpath(await scratch('native-exchange-prepare-'));
		roots.push(folder);
		await writeFile(join(folder, 'note.md'), 'read');
		const boundary = createNativeFileBoundary(folder);

		// The loader has not loaded anything yet in this process.
		hidden = 'source';
		let thrown: unknown;
		await exchangeFiles(join(folder, 'a'), join(folder, 'note.md')).catch(
			(cause) => {
				thrown = cause;
			},
		);
		const loading = thrown as Error & { code?: unknown };
		expect(loading).toBeInstanceOf(Error);
		expect(loading.code).toBeUndefined();
		expect((loading.cause as { code?: string }).code).toBe('ENOENT');
		expect(loading.message).toContain('exchange.c');
		expect(loading.message).toContain('ENOENT');
		// Rebuilding does not restore a missing source; nothing claims it would.
		expect(loading.message).not.toContain('build:addon');
		const packaging = expectErr(await boundary.apply([await replace('mine')]));
		expect(packaging.name).toBe('Io');
		expect(packaging.message).toContain('ENOENT');
		expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('read');
		expect(await readdir(join(folder, '.git', 'epicenter', 'scratch'))).toEqual(
			[],
		);

		for (const state of ['missing', 'stale'] as const) {
			hidden = state;
			const refused = expectErr(await boundary.apply([await replace('mine')]));
			expect(refused.name).toBe('Io');
			expect(refused.message).toContain(
				state === 'missing' ? 'is not built' : 'is stale',
			);
			expect(refused.message).toContain(
				'bun run --filter @epicenter/folder build:addon',
			);
			expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('read');
			expect(
				await readdir(join(folder, '.git', 'epicenter', 'scratch')),
			).toEqual([]);
		}

		hidden = undefined;
		const { error } = await boundary.apply([await replace('mine')]);
		expect(error).toBeNull();
		expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('mine');
	},
);
