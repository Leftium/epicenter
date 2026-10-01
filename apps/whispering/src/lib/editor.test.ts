/** Conflict reads must distinguish a missing file from an unreadable saved version. */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileError, type FolderFiles } from '@epicenter/app/files';
import type { InstantString } from '@epicenter/app/field';
import { openNativeFolder } from '@epicenter/app/files/native';
import { expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from './definition.js';

const { createTextFileEditor, createRowEditor } = await import(
	'./editor.svelte.ts'
);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function open() {
	const root = await mkdtemp(join(tmpdir(), 'whispering-conflict-'));
	const folder = await openNativeFolder({
		root,
		definition: whisperingDefinition,
		git: {
			author: { name: 'Test', email: 'test@localhost' },
			commitOnEdit: false,
		},
	});
	cleanup.push(async () => {
		await folder.close();
		await rm(root, { recursive: true, force: true });
	});
	return folder;
}

for (const failure of ['unreachable', 'binary'] as const) {
	test(`a conflict read that is ${failure} keeps input and allows a later reread`, async () => {
		const folder = await open();
		const version = expectOk(
			await folder.files.write('note.md', 'original', { expected: 'absent' }),
		);
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
			{ path: 'note.md', source: 'original', version },
			{ paused: true },
			() => {},
		);
		cleanup.push(async () => editor.dispose());
		expectOk(
			await folder.files.write(
				'note.md',
				failure === 'binary' ? new Uint8Array([0, 255]) : 'outside',
				{ expected: version },
			),
		);
		editor.input('my typing');
		await editor.save();
		expect(editor.saveState.kind).toBe('failed');
		expect(editor.buffer).toBe('my typing');
		expect(editor.baseline.version).toEqual(version);
		blocked = false;
		expectOk(
			await folder.files.write('note.md', 'outside', { expected: 'any' }),
		);
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
	const outside = expectOk(await table.update(entry, { body: 'outside' }));
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
	const version = expectOk(
		await folder.files.write('note.md', 'original', { expected: 'absent' }),
	);
	let blocked = true;
	const editor = createTextFileEditor(
		{
			...folder.files,
			write: (...args) => {
				if (blocked) return Promise.reject(new Error('host disappeared'));
				return folder.files.write(...args);
			},
		},
		{ path: 'note.md', source: 'original', version },
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
