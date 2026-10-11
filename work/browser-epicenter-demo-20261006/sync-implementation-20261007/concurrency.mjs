import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { chromium, expect } = createRequire(
	'/Users/braden/Code/worktrees/epicenter/app-schema-derive-export-import/packages/app/package.json',
)('playwright/test');
const evidence = import.meta.dir,
	initial = JSON.parse(await readFile(join(evidence, 'journey.json'), 'utf8'));
const launch = (
	await readFile('/tmp/zhongwen-local-sync-20261007.log', 'utf8')
).match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]*/)[0];
const report = { steps: [], errors: [] };
const contexts = [];
async function open(id) {
	const c = await chromium.launchPersistentContext(
		join(initial.profileRoot, id),
		{ headless: true },
	);
	contexts.push(c);
	const p = await c.newPage();
	p.on('pageerror', (e) => report.errors.push(e.message));
	await p.goto(launch, { waitUntil: 'networkidle' });
	await sync(p);
	await words(p);
	return p;
}
async function words(p) {
	await p.getByRole('link', { name: 'Words', exact: true }).click();
}
async function startSync(p) {
	await p.getByRole('link', { name: 'Sync', exact: true }).click();
	await p.getByRole('button', { name: 'Sync now', exact: true }).click();
}
async function sync(p) {
	await startSync(p);
	await expect(p.getByText(/^Synced:/)).toBeVisible({ timeout: 60000 });
}
async function add(p, text) {
	await p
		.getByRole('textbox', {
			name: 'Add expressions, one per line',
			exact: true,
		})
		.fill(text);
	await p.getByRole('button', { name: 'Review', exact: true }).click();
	await p.getByRole('button', { name: 'Add 1 selected', exact: true }).click();
	await expect(
		p.getByRole('article', { name: text, exact: true }),
	).toBeVisible();
}
const expression = '同步（端到端同步验收20261007）';
async function note(p, text) {
	const card = p.getByRole('article', { name: expression, exact: true });
	await card.getByLabel('Your note', { exact: true }).fill(text);
	await expect(card.getByText('Saved', { exact: true })).toBeVisible();
}
async function bytes(p) {
	return p.evaluate(async () => {
		let d = await navigator.storage.getDirectory();
		for (const x of [
			'Epicenter',
			'local',
			'com.bradenwong.zhongwen',
			'entries',
		])
			d = await d.getDirectoryHandle(x);
		return await (
			await (await d.getFileHandle('howhtlj96t.md')).getFile()
		).text();
	});
}
try {
	const a = await open('a'),
		b = await open('b');
	await add(a, '独立编辑甲（验收20261007）');
	await add(b, '独立编辑乙（验收20261007）');
	await sync(a);
	await sync(b);
	await words(b);
	await expect(
		b.getByRole('article', { name: '独立编辑甲（验收20261007）', exact: true }),
	).toBeVisible();
	await sync(a);
	await words(a);
	await expect(
		a.getByRole('article', { name: '独立编辑乙（验收20261007）', exact: true }),
	).toBeVisible();
	report.steps.push(
		'Independent edits merged through real GitHub; both actual browser profiles contain both additions',
	);
	await words(b);
	const original = await a
		.getByRole('article', { name: expression, exact: true })
		.getByLabel('Your note', { exact: true })
		.inputValue();
	const ours = original + ' Conflict fixture B.',
		theirs = original + ' Conflict fixture A.';
	await note(a, theirs);
	await note(b, ours);
	const before = await bytes(b);
	await sync(a);
	await startSync(b);
	await expect(
		b.getByText('Both sides changed the same file', { exact: true }),
	).toBeVisible({ timeout: 60000 });
	if ((await bytes(b)) !== before)
		throw Error('Conflict changed local saved bytes');
	await expect(b.locator('pre').filter({ hasText: ours })).toBeVisible();
	await expect(b.locator('pre').filter({ hasText: theirs })).toBeVisible();
	report.steps.push(
		'Overlapping edits refused without changing local bytes; both exact stored versions displayed',
	);
	await b.screenshot({
		path: join(evidence, 'app-conflict.png'),
		fullPage: true,
	});
	await b
		.getByRole('radio', { name: "Use GitHub's version", exact: true })
		.click();
	await b
		.getByRole('button', { name: 'Use these versions and sync', exact: true })
		.click();
	await expect(b.getByText(/^Synced:/)).toBeVisible({ timeout: 60000 });
	await words(b);
	await expect(
		b
			.getByRole('article', { name: expression, exact: true })
			.getByLabel('Your note', { exact: true }),
	).toHaveValue(theirs);
	report.steps.push('Explicit conflict choice merged and pushed successfully');
	console.log(JSON.stringify(report));
} finally {
	for (const c of contexts) await c.close();
	await writeFile(
		join(evidence, 'concurrency.json'),
		JSON.stringify(report, null, 2) + '\n',
	);
}
