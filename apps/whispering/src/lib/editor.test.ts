/** Conflict reads must distinguish a missing file from an unreadable saved version. */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstantString } from '@epicenter/definition';
import { FileError, type FolderFiles } from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';
import { openTestFolder } from './workspace.test-support.js';

const { createTextFileEditor, createRowEditor } = await import(
	'./editor.svelte.ts'
);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function open() {
	const root = await mkdtemp(join(tmpdir(), 'whispering-conflict-'));
	const folder = await openTestFolder(root, { commitOnEdit: false });
	cleanup.push(async () => {
		await folder.close();
		await rm(root, { recursive: true, force: true });
	});
	return folder;
}

for (const failure of ['unreachable', 'binary'] as const) {
	test(`a conflict read that is ${failure} keeps input and allows a later reread`, async () => {
		const folder = await open();
		const saved = expectOk(await folder.files.create('note.md', 'original'));
		const { sha256 } = saved;
		let blocked = true;
		const files: FolderFiles = {
			...folder.files,
			read: (path) =>
				blocked && failure === 'unreachable'
					? Promise.resolve(
							FileError.Io({
								path,
								operation: 'read',
								cause: new Error('host unreachable'),
							}),
						)
					: folder.files.read(path),
		};
		const editor = createTextFileEditor(
			files,
			{ path: 'note.md', source: 'original', sha256 },
			{ paused: true },
			() => {},
		);
		cleanup.push(async () => editor.dispose());
		expectOk(
			await folder.files.replace(
				saved,
				failure === 'binary' ? new Uint8Array([0, 255]) : 'outside',
			),
		);
		editor.input('my typing');
		await editor.save();
		expect(editor.saveState.kind).toBe('failed');
		expect(editor.buffer).toBe('my typing');
		expect(editor.baseline.sha256).toEqual(sha256);
		blocked = false;
		expectOk(await folder.files.overwrite('note.md', 'outside'));
		await editor.retry();
		expect(editor.saveState).toMatchObject({
			kind: 'conflict',
			current: { source: 'outside' },
		});
		expect(editor.buffer).toBe('my typing');
	});
}

test('a recording conflict read failure preserves typing instead of reporting removal', async () => {
	const folder = await open();
	const table = folder.tables.recordings;
	const entry = expectOk(
		await table.create({
			stem: 'one',
			fields: {
				title: 'One',
				recordedAt: '2026-10-01T00:00:00.000Z' as InstantString,
				durationMs: 1,
				capture: 'fixture',
				audioPath: 'recordings/one.wav',
			},
		}),
	);
	let blocked = true;
	const editor = createRowEditor(
		{
			...table,
			get: (stem) =>
				blocked
					? Promise.resolve(
							FileError.Io({
								path: `recordings/${stem}.md`,
								operation: 'read',
								cause: new Error('host unreachable'),
							}),
						)
					: table.get(stem),
		},
		folder.files,
		entry,
		{ paused: true },
		() => {},
	);
	cleanup.push(async () => editor.dispose());
	const outside = expectOk(
		await table.update(entry.stem!, { body: 'outside' }),
	);
	const typing = `${entry.source}my typing`;
	editor.input(typing);
	await editor.save();
	expect(editor.saveState.kind).toBe('failed');
	expect(editor.buffer).toBe(typing);
	blocked = false;
	await editor.retry();
	expect(editor.saveState).toMatchObject({
		kind: 'conflict',
		current: { source: outside.source },
	});
});

test('a rejected save leaves the draft failed and retryable', async () => {
	const folder = await open();
	const { sha256 } = expectOk(await folder.files.create('note.md', 'original'));
	let blocked = true;
	const editor = createTextFileEditor(
		{
			...folder.files,
			replace: (...args) => {
				if (blocked) return Promise.reject(new Error('host disappeared'));
				return folder.files.replace(...args);
			},
		},
		{ path: 'note.md', source: 'original', sha256 },
		{ paused: true },
		() => {},
	);
	cleanup.push(async () => editor.dispose());
	editor.input('my typing');
	await editor.save();
	expect(editor.saveState).toMatchObject({
		kind: 'failed',
		message: 'host disappeared',
	});
	expect(editor.buffer).toBe('my typing');
	blocked = false;
	await editor.retry();
	expect(editor.saveState.kind).toBe('saved');
	expect(editor.dirty).toBe(false);
});

for (const readFailure of [false, true]) {
	test(`an unacknowledged saved draft reconciles without a false conflict${readFailure ? ' after a failed confirmation read' : ''}`, async () => {
		const folder = await open();
		const { sha256: original } = expectOk(
			await folder.files.create('note.md', 'original'),
		);
		let confirmationFails = readFailure;
		const files: FolderFiles = {
			...folder.files,
			async replace(file, source) {
				const result = await folder.files.replace(file, source);
				return result.error
					? result
					: FileError.Unconfirmed({
							path: file.path,
							operation: 'replace',
							cause: 'reply lost after saving',
						});
			},
			read: (path) =>
				confirmationFails
					? Promise.resolve(
							FileError.Io({
								path,
								operation: 'read',
								cause: 'confirmation unavailable',
							}),
						)
					: folder.files.read(path),
		};
		let saved = 0;
		const editor = createTextFileEditor(
			files,
			{ path: 'note.md', source: 'original', sha256: original },
			{ paused: true },
			() => {
				saved++;
			},
		);
		editor.input('desired');
		await editor.save();
		if (readFailure) {
			expect(editor.saveState.kind).toBe('failed');
			expect(editor.buffer).toBe('desired');
			confirmationFails = false;
			await editor.save();
		}
		expect(editor.saveState.kind).toBe('saved');
		expect(editor.dirty).toBe(false);
		expect(saved).toBe(1);
		expect(
			new TextDecoder().decode(
				expectOk(await folder.files.read('note.md')).bytes,
			),
		).toBe('desired');
		editor.dispose();
	});
}
