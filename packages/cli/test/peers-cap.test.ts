/**
 * Wave 8 / Invariant 6 coverage: `peers --wait` cap and hint behavior.
 *
 * Spawns the real CLI binary because the cap path calls `process.exit(1)`,
 * which can't be exercised in-process without tearing down the test runner.
 *
 * Cases:
 *   - `--wait 60000` exits 1 with the literal capped-message.
 *   - `--wait 10000` succeeds (or exits with the no-peers/connect path) and
 *     prints the hint to stderr.
 *   - `--wait 1000` prints neither the cap message nor the hint.
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

describe('peers --wait cap (Invariant 6)', () => {
	test('--wait 60000 exits 1 with the capped-message', async () => {
		const { stderr, exitCode } = await runCli(['peers', '--wait', '60000']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain(
			'--wait capped at 30000 ms; use `epicenter up` for long-lived presence',
		);
	});

	test('--wait 10000 prints the hint to stderr (does not exit on cap)', async () => {
		const { stderr } = await runCli(['peers', '--wait', '10000']);
		// The hint always fires above 5000ms, regardless of whether the
		// underlying snapshot finds peers (the inline-actions fixture has no
		// sync attachment, so we just look for the hint line).
		expect(stderr).toContain(
			'Tip: for long-lived presence, see `epicenter up`.',
		);
		expect(stderr).not.toContain('--wait capped');
	});

	test('--wait 1000 is silent (no cap, no hint)', async () => {
		const { stderr } = await runCli(['peers', '--wait', '1000']);
		expect(stderr).not.toContain('--wait capped');
		expect(stderr).not.toContain('Tip: for long-lived presence');
	});
});
