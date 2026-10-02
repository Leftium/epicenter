/**
 * Native Same-Owner Concurrency Tests
 *
 * One opened native folder applies its own batches one at a time. Two saves
 * that both observed the same sha256 must not both pass their checks and
 * then replace each other; the later one checks what the earlier one left.
 * This covers the handle only: another program still races the check.
 *
 * Key behaviors:
 * - Two conditional writes of one version through one boundary give one
 *   success and one `Conflict`
 * - Two raw file writes of one version through an opened folder save once
 * - Two table updates of one captured entry save once, and the refused
 *   caller can reread and retry
 * - A save queued behind one that fails, or that ends `Partial`, still
 *   publishes
 *
 * See also:
 * - `native-publication.test.ts` for the check against other programs
 */
import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs/promises';
import { join, sep } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { hashBytes } from './capture.js';
import { defineFolder, defineTable, field } from './contract.js';
import { GIT_ENV, scratch } from './git-http.test-support.js';

const real = { ...realFs };
const { readdir, readFile, realpath, rm, writeFile } = real;

/** Runs before a staged file is renamed into the folder, when set. */
let beforeRename: (() => Promise<void>) | undefined;
const SCRATCH = `${sep}.git${sep}epicenter${sep}scratch${sep}`;

// The native store reads this binding at call time, so the hook observes the
// real rename without a production seam.
mock.module('node:fs/promises', () => ({
	...real,
	default: real,
	async rename(...args: Parameters<typeof real.rename>) {
		if (String(args[0]).includes(SCRATCH)) await beforeRename?.();
		return real.rename(...args);
	},
}));

const { createNativeFileBoundary } = await import('./native-store.js');
const { openNativeFolder } = await import('./directory.test-support.js');

const definition = defineFolder({
	id: 'so.epicenter.concurrencytest',
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
const author = { name: 'App', email: 'app@example.test' };
const encoder = new TextEncoder();
const roots: string[] = [];
const originalGlobal = process.env.GIT_CONFIG_GLOBAL;

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
});
afterAll(() => {
	if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
});
afterEach(async () => {
	beforeRename = undefined;
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function root(prefix: string) {
	const created = await realpath(await scratch(prefix));
	roots.push(created);
	return created;
}

async function replace(path: string, expectedText: string, text: string) {
	const bytes = encoder.encode(text);
	return {
		kind: 'replace' as const,
		path,
		bytes,
		sha256: await hashBytes(bytes),
		expectedSha256: await hashBytes(encoder.encode(expectedText)),
	};
}

async function scratchFiles(folder: string) {
	return readdir(join(folder, '.git', 'epicenter', 'scratch')).catch(() => []);
}

/**
 * Hold the first rename until a second publication reaches its own rename, so
 * both have passed their sha256 checks before either lands. A boundary that
 * runs one batch at a time never sends the second one there, so the timer
 * releases the first. `fail` makes that first rename throw once released.
 */
function holdFirstRename({ fail = false } = {}) {
	let arrivals = 0;
	let overlapped = false;
	const { promise: second, resolve: secondArrived } =
		Promise.withResolvers<void>();
	beforeRename = async () => {
		if (++arrivals > 1) return secondArrived();
		let timer: ReturnType<typeof setTimeout> | undefined;
		overlapped = await Promise.race([
			second.then(() => true),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), 250);
			}),
		]);
		clearTimeout(timer);
		if (fail) throw new Error('rename refused');
	};
	return {
		get overlapped() {
			return overlapped;
		},
	};
}

test('two saves of one version through one boundary give one success and one conflict', async () => {
	const folder = await root('native-same-owner-');
	await writeFile(join(folder, 'note.md'), 'read');
	const boundary = createNativeFileBoundary(folder);
	const held = holdFirstRename();

	const [first, second] = await Promise.all([
		boundary.apply([await replace('note.md', 'read', 'first')]),
		boundary.apply([await replace('note.md', 'read', 'second')]),
	]);

	expect(held.overlapped).toBe(false);
	expectOk(first);
	const refused = expectErr(second);
	expect(refused.name).toBe('Conflict');
	if (refused.name !== 'Conflict') return;
	expect(refused.actualSha256).toEqual(
		await hashBytes(encoder.encode('first')),
	);
	expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('first');
	expect(await scratchFiles(folder)).toEqual([]);
});

test('two raw writes of one version through an opened folder save once', async () => {
	const folder = await root('native-same-owner-write-');
	const opened = await openNativeFolder({
		root: folder,
		definition,
		git: { author },
	});
	try {
		const captured = expectOk(await opened.files.create('note.md', 'read'));
		holdFirstRename();

		const results = await Promise.all([
			opened.files.replace(captured, 'first'),
			opened.files.replace(captured, 'second'),
		]);

		const firstWon = results[0].error === null;
		const saved = expectOk(firstWon ? results[0] : results[1]);
		expect(expectErr(firstWon ? results[1] : results[0]).name).toBe('Conflict');
		const current = expectOk(await opened.files.read('note.md'));
		expect(current.sha256).toEqual(saved.sha256);
		expect(new TextDecoder().decode(current.bytes)).toBe(
			firstWon ? 'first' : 'second',
		);
	} finally {
		await opened.close();
	}
});

test('racing current-row updates return a conflict without retrying', async () => {
	const folder = await root('native-same-owner-update-');
	const opened = await openNativeFolder({
		root: folder,
		definition,
		git: { author },
	});
	try {
		const captured = expectOk(
			await opened.tables.todos.create({
				stem: 'one',
				fields: { title: 'One', done: false },
			}),
		);
		holdFirstRename();

		const results = await Promise.all([
			opened.tables.todos.update(captured.stem, {
				fields: { title: 'Renamed' },
			}),
			opened.tables.todos.update(captured.stem, { fields: { done: true } }),
		]);

		const firstWon = results[0].error === null;
		expectOk(firstWon ? results[0] : results[1]);
		expect(expectErr(firstWon ? results[1] : results[0]).name).toBe('Conflict');
		const current = expectOk(await opened.tables.todos.get('one'));
		if (current === undefined) throw new Error('the row is missing');
		expect(current.fields).toEqual(
			firstWon
				? { title: 'Renamed', done: false }
				: { title: 'One', done: true },
		);
		// The caller explicitly resubmits; update performs its own current read.
		const retried = expectOk(
			await opened.tables.todos.update('one', {
				fields: firstWon ? { done: true } : { title: 'Renamed' },
			}),
		);
		expect(retried.fields).toEqual({
			title: 'Renamed',
			done: true,
		});
	} finally {
		await opened.close();
	}
});

test('a save queued behind one that fails still publishes', async () => {
	const folder = await root('native-same-owner-failure-');
	await writeFile(join(folder, 'note.md'), 'read');
	const boundary = createNativeFileBoundary(folder);
	holdFirstRename({ fail: true });

	const [first, second] = await Promise.all([
		boundary.apply([await replace('note.md', 'read', 'first')]),
		boundary.apply([await replace('note.md', 'read', 'second')]),
	]);

	expect(expectErr(first).name).toBe('Io');
	expectOk(second);
	expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('second');
	expectOk(await boundary.apply([await replace('note.md', 'second', 'third')]));
	expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('third');
	expect(await scratchFiles(folder)).toEqual([]);
});

test('a save queued behind a partial batch still publishes', async () => {
	const folder = await root('native-same-owner-partial-');
	await writeFile(join(folder, 'note.md'), 'read');
	const boundary = createNativeFileBoundary(folder);
	holdFirstRename({ fail: true });
	const created = encoder.encode('created');

	const [first, second] = await Promise.all([
		boundary.apply([
			// An exclusive creation links instead of renaming, so it lands.
			{
				kind: 'create',
				path: 'new.md',
				bytes: created,
				sha256: await hashBytes(created),
			},
			await replace('note.md', 'read', 'first'),
		]),
		boundary.apply([await replace('note.md', 'read', 'second')]),
	]);

	const partial = expectErr(first);
	expect(partial.name).toBe('Partial');
	if (partial.name !== 'Partial') return;
	expect(partial.applied).toEqual([{ kind: 'write', path: 'new.md' }]);
	expect(partial.failed).toEqual({ kind: 'write', path: 'note.md' });
	expectOk(second);
	expect(await readFile(join(folder, 'new.md'), 'utf8')).toBe('created');
	expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('second');
});
