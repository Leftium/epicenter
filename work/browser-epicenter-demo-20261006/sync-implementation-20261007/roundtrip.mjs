import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(
	'/Users/braden/Code/worktrees/epicenter/app-schema-derive-export-import/packages/app/package.json',
);
const { chromium, expect } = require('playwright/test');
const evidence = import.meta.dir;
const initial = JSON.parse(
	await readFile(join(evidence, 'journey.json'), 'utf8'),
);
const launch = (
	await readFile('/tmp/zhongwen-local-sync-20261007.log', 'utf8')
).match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]*/)[0];
const context = await chromium.launchPersistentContext(
	join(initial.profileRoot, 'b'),
	{ headless: true, viewport: { width: 1280, height: 900 } },
);
const page = await context.newPage();
const report = { steps: [], errors: [] };
page.on('pageerror', (e) => report.errors.push(e.message));
try {
	await page.goto(launch, { waitUntil: 'networkidle' });
	await page.getByRole('button', { name: 'Sync now', exact: true }).click();
	await expect(page.getByText(/^Synced:/)).toBeVisible({ timeout: 60000 });
	await page.getByRole('link', { name: 'Words', exact: true }).click();
	const expression = '同步（端到端同步验收20261007）';
	const card = page.getByRole('article', { name: expression, exact: true });
	await expect(card.getByLabel('Your note', { exact: true })).toHaveValue(
		/Desktop roundtrip verified/,
	);
	report.steps.push('Browser downloaded the desktop edit through app Sync');
	// Unsaved additions must survive an attempted navigation to Sync.
	await page
		.getByRole('textbox', {
			name: 'Add expressions, one per line',
			exact: true,
		})
		.fill('未提交的测试');
	await page.getByRole('link', { name: 'Sync', exact: true }).click();
	await expect(
		page.getByRole('textbox', {
			name: 'Add expressions, one per line',
			exact: true,
		}),
	).toHaveValue('未提交的测试');
	await expect(page.getByRole('alert')).toContainText(
		'Add your expressions or clear the input',
	);
	await page
		.getByRole('textbox', {
			name: 'Add expressions, one per line',
			exact: true,
		})
		.fill('');
	report.steps.push('Sync navigation preserved unsaved vocabulary input');
	await card
		.getByRole('checkbox', {
			name: `Choose ${expression} for practice`,
			exact: true,
		})
		.check();
	await page
		.getByRole('button', { name: 'Start practice', exact: true })
		.click();
	await expect(
		page.getByRole('textbox', { name: 'Your message', exact: true }),
	).toBeVisible({ timeout: 30000 });
	await expect(
		page.getByRole('button', { name: 'Stop', exact: true }),
	).toHaveCount(0, { timeout: 60000 });
	const files = await page.evaluate(async () => {
		let dir = await navigator.storage.getDirectory();
		for (const p of [
			'Epicenter',
			'local',
			'com.bradenwong.zhongwen',
			'conversations',
		])
			dir = await dir.getDirectoryHandle(p);
		const out = [];
		for await (const [name, h] of dir.entries())
			if (h.kind === 'file')
				out.push({ name, text: await (await h.getFile()).text() });
		return out;
	});
	if (!files.some((f) => f.text.includes('assistant')))
		throw new Error(
			'No completed tutor reply saved: ' +
				(await page.locator('body').innerText()).slice(-2500),
		);
	report.steps.push(
		'Real local Ollama tutor reply saved to a conversation file',
	);
	await page.screenshot({
		path: join(evidence, 'app-tutor.png'),
		fullPage: true,
	});
	await page.getByRole('link', { name: 'Sync', exact: true }).click();
	await page.getByRole('button', { name: 'Sync now', exact: true }).click();
	await expect(page.getByText(/^Synced:/)).toBeVisible({ timeout: 60000 });
	report.steps.push(
		'Actual app synchronized the saved tutor conversation to private GitHub',
	);
	await page.screenshot({
		path: join(evidence, 'app-roundtrip.png'),
		fullPage: true,
	});
	console.log(JSON.stringify(report));
} finally {
	await writeFile(
		join(evidence, 'roundtrip.json'),
		JSON.stringify(report, null, 2) + '\n',
	);
	await context.close();
}
