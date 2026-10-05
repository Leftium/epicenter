/**
 * Native Exchange Tests
 *
 * The Node-API exchange a Bun directory folder's replacements publish with,
 * against the real filesystem, built from `addon/exchange.c`.
 *
 * Key behaviors:
 * - Two existing files trade places in one call
 * - A missing destination or source is `ENOENT`, and neither path changes:
 *   the exchange never creates a file
 * - A path with a NUL character is refused before any system call
 * - A reader in another process sees the old bytes or the new bytes of a
 *   large file, never a mix or a short read, while replacements land
 *
 * See also:
 * - `native-publication.test.ts` for the store's outcomes around the exchange
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashBytes } from './capture.js';
import { exchangeFiles, exchangeSupported } from './native-exchange.js';
import { createNativeFileBoundary } from './native-store.js';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function root() {
	const created = await realpath(await mkdtemp(join(tmpdir(), 'exchange-')));
	roots.push(created);
	return created;
}

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

async function refusal(work: Promise<void>) {
	try {
		await work;
	} catch (cause) {
		return cause as Error & { code?: string; syscall?: string };
	}
	throw new Error('The exchange succeeded');
}

describe.skipIf(!exchangeSupported)('exchangeFiles', () => {
	test('two existing files trade places', async () => {
		const folder = await root();
		await writeFile(join(folder, 'a'), 'A');
		await writeFile(join(folder, 'b'), 'B');

		await exchangeFiles(join(folder, 'a'), join(folder, 'b'));

		expect(await readFile(join(folder, 'a'), 'utf8')).toBe('B');
		expect(await readFile(join(folder, 'b'), 'utf8')).toBe('A');
	});

	test('a missing destination is ENOENT and is not created', async () => {
		const folder = await root();
		await writeFile(join(folder, 'staged'), 'new');

		const error = await refusal(
			exchangeFiles(join(folder, 'staged'), join(folder, 'gone')),
		);

		expect(error.code).toBe('ENOENT');
		expect(error.syscall).toBe(
			process.platform === 'darwin' ? 'renamex_np' : 'renameat2',
		);
		expect(await exists(join(folder, 'gone'))).toBe(false);
		expect(await readFile(join(folder, 'staged'), 'utf8')).toBe('new');
	});

	test('a missing source is ENOENT and the destination stays', async () => {
		const folder = await root();
		await writeFile(join(folder, 'target'), 'old');

		const error = await refusal(
			exchangeFiles(join(folder, 'gone'), join(folder, 'target')),
		);

		expect(error.code).toBe('ENOENT');
		expect(await readFile(join(folder, 'target'), 'utf8')).toBe('old');
		expect(await readdir(folder)).toEqual(['target']);
	});

	test('a path with a NUL character is refused before the system call', async () => {
		const folder = await root();
		await writeFile(join(folder, 'a'), 'A');
		await writeFile(join(folder, 'b'), 'B');

		const error = await refusal(
			exchangeFiles(join(folder, 'a\0b'), join(folder, 'b')),
		);

		expect(error).toBeInstanceOf(TypeError);
		expect(await readFile(join(folder, 'b'), 'utf8')).toBe('B');
	});

	test('a reader in another process never sees part of a large replacement', async () => {
		const folder = await root();
		// Different sizes and fills: a short read or a mix of the two shows.
		const versions = [
			new Uint8Array(8 * 1024 * 1024).fill(0x41),
			new Uint8Array(12 * 1024 * 1024).fill(0x42),
		];
		await writeFile(join(folder, 'large.bin'), versions[0]!);
		await mkdir(join(folder, '.git'));
		const ready = join(folder, '.git', 'ready');
		const stop = join(folder, '.git', 'stop');
		const reader = Bun.spawn(
			[
				process.execPath,
				'-e',
				`
const { readFileSync, existsSync, writeFileSync } = require('node:fs');
const [path, ready, stop] = process.argv.slice(-3);
const expected = new Map([
	[8 * 1024 * 1024, Buffer.alloc(8 * 1024 * 1024, 0x41)],
	[12 * 1024 * 1024, Buffer.alloc(12 * 1024 * 1024, 0x42)],
]);
let reads = 0, bad = 0, seen = new Set();
writeFileSync(ready, '');
while (!existsSync(stop)) {
	const bytes = readFileSync(path);
	const version = expected.get(bytes.length);
	reads++;
	if (version === undefined || !bytes.equals(version)) bad++;
	else seen.add(version[0]);
}
console.log(JSON.stringify({ reads, bad, seen: [...seen].sort() }));
`,
				join(folder, 'large.bin'),
				ready,
				stop,
			],
			{ stdout: 'pipe', stderr: 'inherit' },
		);
		while (!(await exists(ready))) await Bun.sleep(5);
		const boundary = createNativeFileBoundary(folder);
		const sha256 = await Promise.all(versions.map((bytes) => hashBytes(bytes)));

		for (let round = 1; round <= 40; round++) {
			const next = round % 2;
			const { error } = await boundary.apply([
				{
					kind: 'replace',
					path: 'large.bin',
					bytes: versions[next]!,
					sha256: sha256[next]!,
					expectedSha256: sha256[1 - next]!,
				},
			]);
			expect(error).toBeNull();
		}
		await writeFile(stop, '');
		const report = JSON.parse(await new Response(reader.stdout).text()) as {
			reads: number;
			bad: number;
			seen: number[];
		};
		expect(await reader.exited).toBe(0);

		expect(report.reads).toBeGreaterThan(0);
		expect(report.bad).toBe(0);
		expect(await readdir(join(folder, '.git', 'epicenter', 'scratch'))).toEqual(
			[],
		);
	});
});
