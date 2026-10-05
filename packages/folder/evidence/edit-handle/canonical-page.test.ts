/**
 * Row Editor Callers Page Tests
 *
 * Runs `canonical-page.journeys.ts`, which builds the page as a browser gets
 * it and drives its own DOM in jsdom over the in-memory OPFS, in a process
 * of its own: under `bun test --isolate`, `import()` of the page's entry,
 * which uses top-level await, returns at its first await and the rest never
 * runs.
 *
 * Key behaviors:
 * - A control kept after its view unmounted submits nothing, in vanilla,
 *   Solid, and Svelte, whether the view showed fields or source
 * - Each view keeps its own choice of fields or source across a remount
 * - While Reset holds a write, Open and another row are refused; Reset then
 *   opens the row selected when it was asked, and nothing else is opened
 * - After a failed save, the raw file panel targets that row until its input
 *   is discarded; Keep editing stays on it; the status panel's detached
 *   retry, read, and probe buttons do nothing
 * - A refused Open leaves a held acquisition running; Close cancels one
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('the callers page journeys pass', async () => {
	const child = Bun.spawn(
		[process.execPath, join(import.meta.dir, 'canonical-page.journeys.ts')],
		{ stdout: 'pipe', stderr: 'pipe' },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const report = `${stdout}${stderr}`;
	expect(report).not.toContain('FAIL');
	expect(report.match(/^PASS /gm)).toHaveLength(5);
	expect(code).toBe(0);
}, 120_000);
