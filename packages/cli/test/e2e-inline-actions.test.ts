/**
 * End-to-end coverage for the `list` and `run` commands against a minimal
 * fixture that exercises inline `defineQuery` / `defineMutation` nodes on a
 * `LoadedWorkspace` — no sqlite, sync, or encryption involved.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/load-config';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures/inline-actions');

describe('loadConfig against inline-actions fixture', () => {
	let loaded: Awaited<ReturnType<typeof loadConfig>>;

	beforeAll(async () => {
		loaded = await loadConfig(FIXTURE_DIR);
	});

	afterAll(async () => {
		await loaded.dispose();
	});

	test('discovers the `demo` export as a LoadedWorkspace', () => {
		expect(loaded.entries.map((e) => e.name)).toEqual(['demo']);
		const { workspace } = loaded.entries[0]!;
		expect(typeof workspace[Symbol.dispose]).toBe('function');
		expect(workspace.whenReady).toBeInstanceOf(Promise);
		expect(workspace.actions).toBeDefined();
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

	test('renders a leaf action detail with JSON input shape', async () => {
		const { stdout, exitCode } = await runCli(['list', 'counter.set']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('counter.set  (mutation)');
		expect(stdout).toContain('Input fields (pass as JSON)');
		expect(stdout).toContain('value: number');
		expect(stdout).toContain('required');
	});
});

describe('epicenter run (subprocess)', () => {
	test('invokes a query with no input', async () => {
		const { stdout, exitCode } = await runCli(['run', 'counter.get']);
		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe('0');
	});

	test('accepts inline JSON as the positional input', async () => {
		const { stdout, exitCode } = await runCli([
			'run',
			'counter.set',
			'{"value":9}',
		]);
		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe('9');
	});

	test('accepts @file.json positional', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'epicenter-cli-'));
		const path = join(dir, 'input.json');
		writeFileSync(path, '{"value":11}');
		try {
			const { stdout, exitCode } = await runCli([
				'run',
				'counter.set',
				`@${path}`,
			]);
			expect(exitCode).toBe(0);
			expect(stdout.trim()).toBe('11');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});


	test('accepts JSON piped via stdin', async () => {
		const proc = Bun.spawn(['bun', 'run', BIN_PATH, 'run', 'counter.set'], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
			stdin: 'pipe',
		});
		proc.stdin.write('{"value":15}');
		await proc.stdin.end();
		const [stdout, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited,
		]);
		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe('15');
	});

	test('rejects --wait without --peer', async () => {
		const { stderr, exitCode } = await runCli([
			'run',
			'counter.get',
			'--wait',
			'10000',
		]);
		expect(exitCode).not.toBe(0);
		expect(stderr.toLowerCase()).toContain('missing dependent');
	});

	test('rejects unknown flags under yargs strict mode', async () => {
		const { stderr, exitCode } = await runCli([
			'run',
			'counter.set',
			'--value',
			'7',
		]);
		expect(exitCode).not.toBe(0);
		expect(stderr.toLowerCase()).toContain('unknown argument');
	});

	test('lists siblings when a path lands on a subtree', async () => {
		const { stderr, exitCode } = await runCli(['run', 'counter']);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain('is not a runnable action');
		expect(stderr).toContain('counter.get');
		expect(stderr).toContain('counter.set');
	});

	test('reports the first missing segment', async () => {
		const { stderr, exitCode } = await runCli([
			'run',
			'counter.explode',
		]);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain('is not defined');
		expect(stderr).toContain('counter');
		expect(stderr).toContain('explode');
	});
});
