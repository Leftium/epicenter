/**
 * Watcher Baseline Tests
 *
 * Native file events are turned off here, so only the polling comparison can
 * notice a change. That is the case the owner's baseline refresh exists for.
 *
 * Key behaviors:
 * - A capture this owner created and another program then removed is
 *   reported, though the directory looks as it did before the creation
 * - The same holds for a raw write, and for an outside edit after a save
 */
import { expect, test } from 'bun:test';

async function runScenario(scenario: string) {
	const child = Bun.spawn(
		[
			process.execPath,
			new URL('./watch-baseline.test-support.ts', import.meta.url).pathname,
			scenario,
		],
		{ stdout: 'pipe', stderr: 'pipe' },
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exitCode, output: stdout + stderr }).toEqual({
		exitCode: 0,
		output: '',
	});
}

test('a capture created here and removed outside is noticed without native events', () =>
	runScenario('create'));

test('a raw write removed outside, and an outside edit after a save, are noticed', () =>
	runScenario('raw-and-edit'));
