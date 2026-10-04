/**
 * Vocab acquisition boundary tests.
 * The working page opens the folder with no sign-in in front of it; callback
 * pages and ancestor layouts open nothing; and the earlier account-based
 * stores are reachable only from the import a person asks for.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const source = join(appRoot, 'src');
const routes = join(source, 'routes');
const callback = join(routes, 'auth/callback/+page.svelte');

function ancestorLayouts(page: string): string[] {
	const found: string[] = [];
	for (
		let directory = dirname(page);
		directory.startsWith(routes);
		directory = dirname(directory)
	) {
		const layout = join(directory, '+layout.svelte');
		if (existsSync(layout)) found.push(layout);
	}
	return found;
}

/** Every shipped source file: no tests and no test support. */
async function shippedSources(): Promise<{ path: string; text: string }[]> {
	const names = await readdir(source, { recursive: true });
	const files = names.filter(
		(name) =>
			/\.(ts|svelte)$/.test(name) && !/\.(test|test-support)\.ts$/.test(name),
	);
	return Promise.all(
		files.map(async (name) => ({
			path: relative(source, join(source, name)),
			text: await Bun.file(join(source, name)).text(),
		})),
	);
}

describe('the callback opens nothing', () => {
	test('the callback page exists and has at least one ancestor layout', () => {
		expect(existsSync(callback)).toBe(true);
		expect(ancestorLayouts(callback).length).toBeGreaterThan(0);
	});

	test('callback and ancestor layouts never open the folder or mount the shell', async () => {
		for (const file of [callback, ...ancestorLayouts(callback)]) {
			const text = await Bun.file(file).text();
			expect(text).not.toMatch(/openVocabFolder|openFolder\s*\(/);
			expect(text).not.toMatch(/@epicenter\/folder/);
			expect(text).not.toContain('VocabShell.svelte');
		}
	});
});

describe('the working page needs no account', () => {
	test('the page opens the folder and mounts the shell with no sign-in gate', async () => {
		const page = await Bun.file(join(routes, '+page.svelte')).text();
		expect(page).toContain('openVocabFolder()');
		expect(page).toContain('<VocabShell ');
		expect(page).not.toMatch(/AppBoot|SignInScreen|\$lib\/auth/);
	});

	test('the folder opens through the browser entry, with no account in its declaration', async () => {
		const opener = await Bun.file(join(source, 'lib/folder.ts')).text();
		expect(opener).toContain("from '@epicenter/folder/browser'");
		const declaration = await Bun.file(join(source, 'lib/data.ts')).text();
		expect(declaration).not.toMatch(/accountKey|@epicenter\/auth/);
	});

	test('connected endpoints and the chosen model are kept for the device, never for an account', async () => {
		const files = await shippedSources();
		expect(
			files
				.filter(({ text }) => /openAccountConnectionCatalog/.test(text))
				.map(({ path }) => path),
		).toEqual([]);
		const shell = await Bun.file(
			join(routes, 'components/VocabShell.svelte'),
		).text();
		expect(shell).toContain("createBrowserInferenceSelections('vocab')");
	});

	test('the earlier stores are opened only by the import, which is loaded only on request', async () => {
		const files = await shippedSources();
		const openers = files
			.filter(({ text }) =>
				/@epicenter\/app\/(open|store|memory)|\bopenLocal\b|\bopenPersonal\b|PersistenceNotice|fromData\b/.test(
					text,
				),
			)
			.map(({ path }) => path);
		expect(openers).toEqual(['lib/legacy-source.ts']);

		const importers = files
			.filter(({ text }) => /legacy-source/.test(text))
			.map(({ path, text }) => ({
				path,
				dynamicOnly:
					/import\('\$lib\/legacy-source\.js'\)/.test(text) &&
					!/from '[^']*legacy-source/.test(text),
			}));
		expect(importers).toEqual([
			{ path: 'routes/components/LegacyImport.svelte', dynamicOnly: true },
		]);
	});
});
