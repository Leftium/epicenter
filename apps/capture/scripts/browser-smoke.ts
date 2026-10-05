/**
 * End-to-end check of the browser build's file model, in real Chromium.
 *
 *   bun run --cwd apps/capture smoke:browser
 *
 * Starts the Capture dev server on a free loopback port and drives two pages
 * of one browser profile, which share the OPFS folder: the second page
 * is the "other program" that edits a file behind the first. No account, no
 * server besides Vite, and no data outside the disposable profile.
 *
 * It needs to bind a local port and launch Chromium (`bun x playwright
 * install chromium` once). It does not cover the desktop build: see
 * `src/lib/platform/folder.epicenter-host.test.ts` and the desktop shell.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';

const root = join(import.meta.dir, '../../..');
const fixture = join(import.meta.dir, '../fixtures/legacy-bundle.json');
const artifacts = process.env.CAPTURE_SMOKE_ARTIFACT_DIR;
if (artifacts) mkdirSync(artifacts, { recursive: true });

async function freeOrigin() {
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const origin = `http://127.0.0.1:${server.port}`;
	await server.stop(true);
	return origin;
}

const app = await freeOrigin();
const logs: string[] = [];
const vite: ChildProcess = spawn(
	process.execPath,
	[
		'run',
		'--cwd',
		'apps/capture',
		'dev',
		'--host',
		'127.0.0.1',
		'--port',
		new URL(app).port,
		'--strictPort',
	],
	{
		cwd: root,
		detached: true,
		env: {
			...process.env,
			PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	},
);
vite.stdout?.on('data', (chunk) => logs.push(String(chunk)));
vite.stderr?.on('data', (chunk) => logs.push(String(chunk)));

async function ready(url: string) {
	for (let attempt = 0; attempt < 300; attempt++) {
		try {
			if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
		} catch {}
		assert.equal(vite.exitCode, null, `${url} exited`);
		await Bun.sleep(100);
	}
	throw new Error(`Timed out starting ${url}`);
}

let browser: Browser | undefined;
const errors: string[] = [];

async function saved(page: Page) {
	try {
		await page
			.locator('header [role="status"]')
			.filter({ hasText: /^Saved$/ })
			.waitFor();
	} catch (cause) {
		console.error(
			'Save wait failed at',
			page.url(),
			await page.locator('body').innerText(),
		);
		if (artifacts)
			await page.screenshot({
				path: join(artifacts, 'browser-failure.png'),
				fullPage: true,
			});
		throw cause;
	}
}

/** The file's exact source, as the Source tab shows it. */
async function source(page: Page) {
	await page.getByRole('tab', { name: 'Source' }).click();
	const text = await page.getByLabel('Markdown source').inputValue();
	await page.getByRole('tab', { name: 'Capture', exact: true }).click();
	return text;
}

const thoughts = (page: Page) =>
	page
		.getByLabel('Thoughts', { exact: true })
		.locator('li p')
		.evaluateAll((items) =>
			items.map((item) => (item as HTMLElement).innerText),
		);

async function act(page: Page, index: number, action: string) {
	await page
		.getByLabel('Thoughts', { exact: true })
		.locator('li')
		.nth(index)
		.getByRole('button', { name: 'Thought actions' })
		.click();
	await page.getByRole('menuitem', { name: action }).click();
}

try {
	await ready(app);
	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext();
	const first = await context.newPage();
	first.on('pageerror', (error) => errors.push(`first: ${error.message}`));

	// 1. No sign-in: the timeline opens directly.
	await first.goto(app);
	await first.getByRole('heading', { name: 'Timeline' }).waitFor();

	// 2. The new-capture text survives closing the dialog, then saves exactly.
	const text = 'Dinner with Sebastian\nFriday at seven\nBring the invitation.';
	await first.getByRole('button', { name: 'New capture' }).click();
	await first.getByLabel('Capture text').fill(text);
	await first.getByLabel('Capture text').press('Escape');
	await first.getByRole('button', { name: 'New capture (draft)' }).click();
	assert.equal(await first.getByLabel('Capture text').inputValue(), text);
	// Ctrl+Enter adds it, and the new capture opens ready for a thought.
	await first.getByLabel('Capture text').press('Control+Enter');
	await first.getByRole('tab', { name: 'Source' }).waitFor();
	await first.waitForFunction(
		() => document.activeElement?.id === 'new-thought',
	);
	const captureUrl = first.url();
	// Source shows the file exactly as it was created; a save writes its
	// frontmatter in the canonical form below.
	const created = await source(first);
	const at =
		/^---\ncapturedAt: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\n---\n\nDinner with Sebastian\nFriday at seven\nBring the invitation\.\n\n## Thoughts\n$/.exec(
			created,
		)?.[1];
	assert(at, `unexpected created source:\n${created}`);
	const head = `---\n"capturedAt": "${at}"\n---`;

	// 3. Multiline thoughts: add, edit, reorder, delete. The file is the list.
	for (const thought of [
		'Owning the outcome',
		'Moving to Singapore\nA longer thought',
		'A question for next time',
	]) {
		await first.getByLabel('Add a thought').fill(thought);
		await first.getByRole('button', { name: 'Add thought' }).click();
		// Focus returns to the field, so the next thought needs no pointer.
		assert(
			await first
				.getByLabel('Add a thought')
				.evaluate((field) => field === document.activeElement),
		);
	}
	await act(first, 0, 'Edit');
	await first.getByLabel('Thought text').fill('Owning the outcome, edited');
	await first.getByRole('button', { name: 'Save thought' }).click();
	await act(first, 2, 'Move up');
	await act(first, 0, 'Delete thought…');
	await first.getByRole('button', { name: 'Delete thought' }).click();
	assert.deepEqual(await thoughts(first), [
		'A question for next time',
		'Moving to Singapore\nA longer thought',
	]);
	await saved(first);
	assert.equal(
		await source(first),
		`${head}\n\n${text}\n\n## Thoughts\n\n- A question for next time\n- Moving to Singapore\n  A longer thought\n`,
	);

	// 4. Editing the source is editing the capture: it saves exactly as typed,
	// frontmatter included.
	await first.getByRole('tab', { name: 'Source' }).click();
	const edited = `${head.replace(/\n---$/, '\n"unknownKey": "kept"\n---')}\n\n${text}\n\n## Thoughts\n\n- A question for next time\n  - nested point\n- Moving to Singapore\n  A longer thought\n- Typed in source\n\nTrailing note.\n`;
	await first.getByLabel('Markdown source').fill(edited);
	await saved(first);
	// The views are real tabs: the arrow keys move between them.
	await first.getByRole('tab', { name: 'Source' }).press('ArrowLeft');
	await first.getByLabel('Capture text').waitFor();
	assert.deepEqual(await thoughts(first), [
		'A question for next time\n- nested point',
		'Moving to Singapore\nA longer thought',
		'Typed in source',
	]);
	await saved(first);

	if (artifacts)
		await first.screenshot({
			path: join(artifacts, 'browser-capture.png'),
			fullPage: true,
		});

	// 5. Reload: the saved file is what comes back.
	await first.reload();
	await first.getByLabel('Thoughts', { exact: true }).waitFor();
	assert.equal(await source(first), edited);

	// 6. Another page edits the file. An open capture keeps what it opened
	// with until the person reloads it.
	const second = await context.newPage();
	second.on('pageerror', (error) => errors.push(`second: ${error.message}`));
	await second.goto(captureUrl);
	await second.getByLabel('Capture text').waitFor();
	await second.getByLabel('Capture text').fill('Changed in the other window');
	await saved(second);
	assert.equal(await first.getByLabel('Capture text').inputValue(), text);
	const reloadFromFile = async (page: Page) => {
		await page.getByRole('button', { name: 'More capture actions' }).click();
		await page.getByRole('menuitem', { name: 'Reload from file' }).click();
	};
	await reloadFromFile(first);
	await first.waitForFunction(
		() =>
			(document.querySelector('#capture-text') as HTMLTextAreaElement)
				?.value === 'Changed in the other window',
	);

	// 7. The latest save wins over a change the page never read.
	await first.getByLabel('Capture text').fill('Saved over it');
	await saved(first);
	assert.equal(
		await second.getByLabel('Capture text').inputValue(),
		'Changed in the other window',
	);
	await reloadFromFile(second);
	await second.waitForFunction(
		() =>
			(document.querySelector('#capture-text') as HTMLTextAreaElement)
				?.value === 'Saved over it',
	);

	// 8. Unsent thought text holds a reload back.
	let asked = 0;
	first.on('dialog', (dialog) => {
		asked++;
		void dialog.dismiss();
	});
	await first.getByLabel('Add a thought').fill('typed, not added');
	await first.reload({ timeout: 5000 }).catch(() => {});
	assert.equal(asked, 1, 'unsent thought text is protected');
	assert.equal(
		await first.getByLabel('Add a thought').inputValue(),
		'typed, not added',
	);
	await first.getByLabel('Add a thought').fill('');

	// 9. Text with its own Thoughts list stays source-only, and says why.
	await second.getByRole('button', { name: 'Timeline' }).click();
	await second.getByRole('button', { name: 'New capture' }).click();
	await second
		.getByLabel('Capture text')
		.fill('Pasted article\n\n## Thoughts\n\n- belongs to the article');
	await second.getByRole('button', { name: 'Add capture' }).click();
	await second.getByRole('alert', { name: 'Source only' }).waitFor();
	await second.reload();
	await second.getByRole('alert', { name: 'Source only' }).waitFor();
	await second.getByRole('button', { name: 'Edit Source' }).click();
	assert(
		(await second.getByLabel('Markdown source').inputValue()).includes(
			'- belongs to the article\n\n## Thoughts\n',
		),
	);

	// 10. Deleting reviews the saved file, then removes it.
	await second.getByRole('button', { name: 'More capture actions' }).click();
	await second.getByRole('menuitem', { name: 'Delete capture…' }).click();
	const review = second.getByRole('dialog', {
		name: 'Permanently delete this capture file?',
	});
	assert(
		(await review.getByLabel('Saved file').innerText()).includes(
			'- belongs to the article',
		),
	);
	await review
		.getByRole('button', { name: 'Permanently delete', exact: true })
		.click();
	await second.getByRole('heading', { name: 'Timeline' }).waitFor();
	assert.equal(
		await second.getByLabel('Timeline captures').getByRole('button').count(),
		1,
	);

	// 11. Old captures come in from a bundle file, and a second import adds nothing.
	await second
		.getByRole('button', {
			name: 'Bring in captures from before this version…',
		})
		.click();
	await second.getByLabel('From an export file').setInputFiles(fixture);
	await second
		.getByRole('button', { name: 'Import as Markdown files' })
		.click();
	const result = second.getByRole('region', { name: 'Import result' });
	await result.getByText('Import finished').waitFor();
	await result.getByText('6 files created').waitFor();
	await second
		.getByRole('button', { name: 'Import as Markdown files' })
		.click();
	await result.getByText('0 files created').waitFor();
	await result.getByText('6 imported before and left as they are').waitFor();
	await second.getByRole('button', { name: 'Timeline' }).click();
	assert.equal(
		await second.getByLabel('Timeline captures').getByRole('button').count(),
		7,
	);
	await second
		.getByLabel('Timeline captures')
		.getByRole('button')
		.filter({ hasText: 'Dinner with Sebastian' })
		.getByText('2 thoughts')
		.waitFor();

	// 12. A narrow screen does not scroll sideways.
	await second.setViewportSize({ width: 390, height: 844 });
	assert(
		await second.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	);

	if (artifacts)
		await second.screenshot({
			path: join(artifacts, 'browser-timeline.png'),
			fullPage: true,
		});

	assert.deepEqual(errors, []);
	console.log(
		'Capture browser check passed: no sign-in, exact saved Markdown, multiline thoughts added, edited, reordered, and deleted, source editing, reload persistence, explicit Reload from file and latest-save-wins across two pages, a leave warning for unsent text, a source-only capture, reviewed deletion, and an idempotent import from a bundle file.',
	);
} catch (cause) {
	console.error(cause);
	console.error(logs.slice(-35).join(''));
	throw cause;
} finally {
	await browser?.close();
	if (vite.pid) {
		try {
			process.kill(-vite.pid, 'SIGTERM');
		} catch (cause) {
			if (
				!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')
			)
				console.error('Could not stop the dev server.', cause);
		}
	}
}
