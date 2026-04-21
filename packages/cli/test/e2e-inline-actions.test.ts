/**
 * End-to-end coverage for the `list` and `run` commands against a minimal
 * fixture that exercises inline `defineQuery` / `defineMutation` nodes on a
 * `DocumentHandle` — no sqlite, sync, or encryption involved.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadConfig } from '../src/load-config';
import { resolvePath } from '../src/util/resolve-path';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures/inline-actions');

describe('loadConfig against inline-actions fixture', () => {
	let loaded: Awaited<ReturnType<typeof loadConfig>>;

	beforeAll(async () => {
		loaded = await loadConfig(FIXTURE_DIR);
	});

	afterAll(async () => {
		await loaded.dispose();
	});

	test('discovers the `demo` export as a DocumentHandle', () => {
		expect(loaded.entries.map((e) => e.name)).toEqual(['demo']);
		const entry = loaded.entries[0]!;
		expect(typeof entry.handle.dispose).toBe('function');
		expect(typeof (entry.handle as any)[Symbol.dispose]).toBe('function');
		expect((entry.handle as any).ydoc).toBeDefined();
	});

	test('bundle is the handle prototype, not the handle itself', () => {
		const handle = loaded.entries[0]!.handle;
		const bundle = Object.getPrototypeOf(handle);
		// Handle owns just the disposers; the bundle owns user attachments.
		expect(Object.keys(handle)).toEqual([]);
		expect(Object.keys(bundle)).toContain('counter');
		expect(Object.keys(bundle)).toContain('ydoc');
	});
});

describe('resolvePath', () => {
	let bundle: unknown;

	beforeAll(async () => {
		const loaded = await loadConfig(FIXTURE_DIR);
		bundle = Object.getPrototypeOf(loaded.entries[0]!.handle);
		// Keep the workspace open for the duration of this describe; closed in
		// the loadConfig describe's afterAll via shared cache (refcount).
	});

	test('resolves a leaf action', () => {
		const r = resolvePath(bundle, ['counter', 'get']);
		expect(r.kind).toBe('action');
		if (r.kind === 'action') {
			expect(r.action.type).toBe('query');
			expect(r.path).toEqual(['counter', 'get']);
		}
	});

	test('resolves a subtree node', () => {
		const r = resolvePath(bundle, ['counter']);
		expect(r.kind).toBe('subtree');
	});

	test('reports the first missing segment', () => {
		const r = resolvePath(bundle, ['counter', 'nope', 'further']);
		expect(r.kind).toBe('missing');
		if (r.kind === 'missing') {
			expect(r.lastGoodPath).toEqual(['counter']);
			expect(r.missingSegment).toBe('nope');
		}
	});

	test('invoking a resolved action mutates state observably', async () => {
		const get = resolvePath(bundle, ['counter', 'get']);
		const inc = resolvePath(bundle, ['counter', 'increment']);
		if (get.kind !== 'action' || inc.kind !== 'action') {
			throw new Error('expected actions');
		}
		const before = await get.action();
		await inc.action();
		const after = await get.action();
		expect(after).toBe((before as number) + 1);
	});

	test('invoking a mutation with an input schema applies the input', async () => {
		const set = resolvePath(bundle, ['counter', 'set']);
		const get = resolvePath(bundle, ['counter', 'get']);
		if (set.kind !== 'action' || get.kind !== 'action') {
			throw new Error('expected actions');
		}
		await (set.action as any)({ value: 42 });
		expect(await get.action()).toBe(42);
	});
});

describe('loadConfig error paths', () => {
	test('throws a helpful error when the config file is missing', async () => {
		await expect(loadConfig(join(FIXTURE_DIR, '..'))).rejects.toThrow(
			/No epicenter\.config\.ts/,
		);
	});
});

// ─── Subprocess coverage ─────────────────────────────────────────────────────
// Runs the real `bin.ts` against the fixture cwd. This is the only way to
// exercise yargs strictness + positional parsing; direct handler invocation
// stops short of the yargs layer.

const BIN_PATH = join(import.meta.dir, '..', 'src', 'bin.ts');

async function runCli(
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(['bun', 'run', BIN_PATH, ...args], {
		cwd: FIXTURE_DIR,
		stdout: 'pipe',
		stderr: 'pipe',
		stdin: 'ignore',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe('epicenter list (subprocess)', () => {
	test('renders the full tree with no arguments', async () => {
		const { stdout, exitCode } = await runCli(['list']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('demo');
		expect(stdout).toContain('counter');
		expect(stdout).toContain('get  (query)');
		expect(stdout).toContain('increment  (mutation)');
		expect(stdout).toContain('set  (mutation)');
	});

	test('renders a leaf action detail with argument help', async () => {
		const { stdout, exitCode } = await runCli(['list', 'demo.counter.set']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('demo.counter.set  (mutation)');
		expect(stdout).toContain('--value <number>');
		expect(stdout).toContain('required');
	});
});

describe('epicenter run (subprocess)', () => {
	test('invokes a query with no input', async () => {
		const { stdout, exitCode } = await runCli(['run', 'demo.counter.get']);
		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe('0');
	});

	test('passes flag-shaped inputs through to the action', async () => {
		const { stdout, exitCode } = await runCli([
			'run',
			'demo.counter.set',
			'--value',
			'7',
		]);
		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe('7');
	});

	test('accepts inline JSON as the positional input', async () => {
		const { stdout, exitCode } = await runCli([
			'run',
			'demo.counter.set',
			'{"value":9}',
		]);
		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe('9');
	});

	test('lists siblings when a path lands on a subtree', async () => {
		const { stderr, exitCode } = await runCli(['run', 'demo.counter']);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain('is not a runnable action');
		expect(stderr).toContain('demo.counter.get');
		expect(stderr).toContain('demo.counter.set');
	});

	test('reports the first missing segment', async () => {
		const { stderr, exitCode } = await runCli([
			'run',
			'demo.counter.explode',
		]);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain('is not defined');
		expect(stderr).toContain('demo.counter');
		expect(stderr).toContain('explode');
	});
});
