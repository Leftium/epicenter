import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(
	'/Users/braden/Code/worktrees/epicenter/app-schema-derive-export-import/packages/app/package.json',
);
const { chromium, expect } = require('playwright/test');
const log = await readFile(process.argv[2], 'utf8');
const launchUrl = log.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]*/)?.[0];
if (!launchUrl) throw new Error('No local launch URL in private launcher log');
const origin = new URL(launchUrl).origin;
const root = await mkdtemp(join(tmpdir(), 'zhongwen-app-sync-'));
const evidence = import.meta.dir;
const marker = '端到端同步验收20261007';
const expression = `同步（${marker}）`;
const note =
	'Saved offline in the actual app, then synchronized through private GitHub.';
const report = {
	origin,
	profileRoot: root,
	steps: [],
	requests: [],
	errors: [],
};
const options = { headless: true, viewport: { width: 1280, height: 900 } };
let a, b;
async function open(profile) {
	const context = await chromium.launchPersistentContext(
		join(root, profile),
		options,
	);
	const page = await context.newPage();
	page.on('pageerror', (error) => report.errors.push(error.message));
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (/git|sync|relay/.test(url.pathname))
			report.requests.push({ method: request.method(), path: url.pathname });
	});
	await page.goto(launchUrl, { waitUntil: 'networkidle' });
	await expect(
		page.getByRole('button', { name: 'Sync now', exact: true }),
	).toBeVisible({ timeout: 60000 });
	await page.getByRole('link', { name: 'Words', exact: true }).click();
	return { context, page };
}
async function add(page, text) {
	await page
		.getByRole('textbox', {
			name: 'Add expressions, one per line',
			exact: true,
		})
		.fill(text);
	await page.getByRole('button', { name: 'Review', exact: true }).click();
	await page
		.getByRole('button', { name: 'Add 1 selected', exact: true })
		.click();
	await expect(
		page.getByRole('article', { name: text, exact: true }),
	).toBeVisible();
}
async function readFiles(page) {
	return page.evaluate(async () => {
		let dir = await navigator.storage.getDirectory();
		for (const part of [
			'Epicenter',
			'local',
			'com.bradenwong.zhongwen',
			'entries',
		])
			dir = await dir.getDirectoryHandle(part);
		const files = [];
		for await (const [name, handle] of dir.entries())
			if (handle.kind === 'file')
				files.push({ name, text: await (await handle.getFile()).text() });
		return files;
	});
}
async function sync(page) {
	await page.getByRole('link', { name: 'Sync', exact: true }).click();
	await page.getByRole('button', { name: 'Sync now', exact: true }).click();
	await expect(page.getByText(/^Synced:/)).toBeVisible({ timeout: 60000 });
}
try {
	a = await open('a');
	await a.context.setOffline(true);
	await add(a.page, expression);
	await a.page
		.getByRole('article', { name: expression, exact: true })
		.getByLabel('Your note', { exact: true })
		.fill(note);
	await expect(
		a.page
			.getByRole('article', { name: expression, exact: true })
			.getByText('Saved', { exact: true }),
	).toBeVisible();
	if (
		!(await readFiles(a.page)).some(
			(file) => file.text.includes(expression) && file.text.includes(note),
		)
	)
		throw new Error('Actual saved bytes missing');
	report.steps.push(
		'Actual app saved expression and note while offline; OPFS bytes confirmed',
	);
	await a.page.screenshot({
		path: join(evidence, 'app-offline.png'),
		fullPage: true,
	});
	await a.context.close();
	a = await open('a');
	await expect(
		a.page
			.getByRole('article', { name: expression, exact: true })
			.getByLabel('Your note', { exact: true }),
	).toHaveValue(note);
	report.steps.push('Saved note survived browser profile reopen');
	await sync(a.page);
	report.steps.push('Explicit app Sync completed');
	await a.page.screenshot({
		path: join(evidence, 'app-pushed.png'),
		fullPage: true,
	});
	b = await open('b');
	await expect(
		b.page
			.getByRole('article', { name: expression, exact: true })
			.getByLabel('Your note', { exact: true }),
	).toHaveValue(note);
	report.steps.push(
		'Second actual app browser profile bootstrapped from remote',
	);
	await b.page.screenshot({
		path: join(evidence, 'app-downloaded.png'),
		fullPage: true,
	});
	await writeFile(
		join(evidence, 'journey.json'),
		JSON.stringify(report, null, 2) + '\n',
	);
	console.log(
		JSON.stringify({
			origin,
			steps: report.steps,
			errors: report.errors,
			profileRoot: root,
		}),
	);
} finally {
	await a?.context.close();
	await b?.context.close();
	await writeFile(
		join(evidence, 'journey.json'),
		JSON.stringify(report, null, 2) + '\n',
	);
}
