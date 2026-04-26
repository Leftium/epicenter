/**
 * Subprocess coverage for `list --peer` and `list --all`.
 *
 * Happy-path source helpers (sourceLocal/sourcePeer/sourceAll) are unit-tested
 * in `src/commands/list.test.ts`; here we cover the CLI argv plumbing and the
 * negative paths a real user can hit with the inline-actions fixture (which
 * has no sync attachment, so awareness stays empty).
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures/inline-actions');
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

describe('list --peer (negative paths against fixture without peers)', () => {
	test('exits 3 with peer-not-found message when no peers are connected', async () => {
		const { stderr, exitCode } = await runCli([
			'list',
			'--peer',
			'nonexistent',
			'--wait',
			'0',
		]);
		expect(exitCode).toBe(3);
		expect(stderr).toContain('no peer matches deviceId "nonexistent"');
	});
});

describe('list --peer + --all', () => {
	test('exits 1 with mutex error before any sync work', async () => {
		const { stderr, exitCode } = await runCli([
			'list',
			'--peer',
			'mac',
			'--all',
		]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('--peer and --all are mutually exclusive');
	});
});

describe('list --all (no peers — self-only)', () => {
	test('renders self section with the local action tree', async () => {
		const { stdout, exitCode } = await runCli(['list', '--all', '--wait', '0']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('self (this device)');
		expect(stdout).toContain('counter');
		expect(stdout).toContain('get  (query)');
		expect(stdout).toContain('set  (mutation)');
	});

	test('json mode emits one row per (peer, path) tuple', async () => {
		const { stdout, exitCode } = await runCli([
			'list',
			'--all',
			'--wait',
			'0',
			'--format',
			'json',
		]);
		expect(exitCode).toBe(0);
		const rows = JSON.parse(stdout);
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row).toHaveProperty('peer', 'self');
			expect(row).toHaveProperty('path');
			expect(row).toHaveProperty('type');
		}
	});

	test('--all with a leaf path that exists locally still resolves', async () => {
		const { stdout, exitCode } = await runCli([
			'list',
			'--all',
			'counter.set',
			'--wait',
			'0',
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('self (this device)');
		expect(stdout).toContain('counter.set  (mutation)');
	});

	test('--all with a path that exists nowhere exits non-zero', async () => {
		const { stderr, exitCode } = await runCli([
			'list',
			'--all',
			'counter.nope',
			'--wait',
			'0',
		]);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain('not found on any peer');
	});
});

describe('list (default — local source, no flag)', () => {
	test('reproduces today\'s output (regression guard for ActionMeta retype)', async () => {
		const { stdout, exitCode } = await runCli(['list']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('demo');
		expect(stdout).toContain('counter');
		expect(stdout).toContain('get  (query)');
		expect(stdout).toContain('increment  (mutation)');
		expect(stdout).toContain('set  (mutation)');
	});
});
