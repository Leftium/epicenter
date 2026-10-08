/**
 * Row Editing Tests
 *
 * The app's policy over one real row editor (`table.edit`) on a real
 * directory, opened with the Bun opener. The editor owns the row's input and
 * its saves; this decides which view takes input, when input is taken, and
 * what one line of status says. `workspace/desktop-sequences.test.ts` drives
 * the same editor inside the library over the desktop adapter, where writes
 * can be held, refused, or lose their replies.
 *
 * Key behaviors:
 * - every input is the complete row at once: unknown fields stay, an omitted
 *   field is deleted, the body is saved exactly as given (a textarea's LF
 *   composed into the file's line endings first), and the views show LF
 * - nothing is taken while not admitted, while a reload reads the file, or
 *   after the row is put down; a write already admitted still settles
 * - the fields view exists only for a valid row; source typing is exact and
 *   keeps the source shown until the person chooses the fields
 * - a row the codec refuses changes nothing and keeps only why, beside the
 *   save's own state; taken input, a successful reload, or putting the row
 *   down lets it go, and nothing else does
 * - another writer's change is not loaded until the person reloads, and
 *   otherwise the next save writes over it
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import {
	bodyShown,
	fieldShown,
	sourceShown,
	typeBody,
	typeField,
} from './row-slot.test-support.js';
import { openTestFolder } from './workspace.test-support.js';

const { createRowEditing } = await import('./row-editing.svelte.ts');

const PATH = 'transformations/clean.md';
const SEED =
	'---\ntitle: Clean up\nmodel: null\nendpoint: null\nowner: { name: me }\n---\nTidy.\n';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** One transformation file, its real editor, and the app's policy over it. */
async function open(
	text = SEED,
	{ admitted = { value: true } }: { admitted?: { value: boolean } } = {},
) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-row-editing-')),
	);
	await Bun.write(join(root, PATH), text);
	const folder = await openTestFolder(root, { commitOnEdit: false });
	const native = expectOk(await folder.tables.transformations.edit('clean'));
	const editing = createRowEditing(native, {
		path: PATH,
		admits: () => admitted.value,
	});
	cleanups.push(async () => {
		editing.release();
		await folder.close();
		await rm(root, { recursive: true, force: true });
	});
	const file = () => readFile(join(root, PATH), 'utf8');
	return { root, native, editing, file };
}

test('each input is the complete row at once: unknown fields stay, and an omitted field is deleted', async () => {
	const { editing, file } = await open();

	typeField(editing, 'title', 'Tidy up');
	if (editing.row.status !== 'valid') throw new Error('expected a valid row');
	const { model: _, ...withoutModel } = editing.row.fields;
	expect(
		editing.set({ ...editing.row, fields: withoutModel })?.error,
	).toBeNull();
	// The editor's row is the latest input before anything is written.
	expect(editing.save.status).toBe('saving');
	expect(editing.row.text).toBe(
		'---\n"title": "Tidy up"\n"endpoint": null\n"owner": {"name": "me"}\n---\nTidy.\n',
	);

	expectOk(await editing.waitForSaves());

	expect(await file()).toBe(editing.row.text);
	expect(editing.holds).toBe(false);
	// The row lacks a declared field now: saved, and it needs repair in Source.
	expect(editing.status.kind).toBe('invalid');
	expect(editing.view).toBe('source');
});

test('a body typed in a textarea keeps the file’s own line endings, and the views show LF', async () => {
	const crlf =
		'---\ntitle: Clean up\nmodel: null\nendpoint: null\n---\nOne.\r\nTwo.\r\n';
	const { editing, file } = await open(crlf);
	expect(bodyShown(editing)).toBe('One.\nTwo.\n');

	typeBody(editing, 'One.\nTwo.\nThree.\n');
	expectOk(await editing.waitForSaves());

	expect(await file()).toBe(
		'---\n"title": "Clean up"\n"model": null\n"endpoint": null\n---\nOne.\r\nTwo.\r\nThree.\r\n',
	);
	expect(bodyShown(editing)).toBe('One.\nTwo.\nThree.\n');
	// A field's row carries the body exactly as it is.
	typeField(editing, 'title', 'Tidy');
	expect(editing.row).toMatchObject({ body: 'One.\r\nTwo.\r\nThree.\r\n' });

	expect(editing.showSource(true)).toBeUndefined();
	expect(sourceShown(editing)).not.toContain('\r');
	editing.setText(`${sourceShown(editing)}Four.\n`);
	expectOk(await editing.waitForSaves());
	expect(await file()).toContain('Three.\r\nFour.\r\n');
});

test('a row saves its body exactly as given, mixed line endings included', async () => {
	const { editing, file } = await open();
	if (editing.row.status !== 'valid') throw new Error('expected a valid row');

	expect(
		editing.set({ ...editing.row, body: 'Line.\r\nAnother.\n' })?.error,
	).toBeNull();
	expectOk(await editing.waitForSaves());
	expect(await file()).toContain('---\nLine.\r\nAnother.\n');
});

test('a row the codec refuses changes nothing and keeps only why; a pending save landing keeps it, and taken input lets it go', async () => {
	const { editing, file } = await open();

	// Taken, and saving, when the next typing is refused.
	typeField(editing, 'title', 'Tidy up');
	expect(typeField(editing, 'title', 'Half \uD800')?.error?.name).toBe(
		'Unrepresentable',
	);
	expect(editing.row).toMatchObject({ fields: { title: 'Tidy up' } });
	expect(editing.row.text).not.toContain('\uD800');
	expect(fieldShown(editing, 'title')).toBe('Tidy up');
	expect(editing.refusal?.reason).toContain('lone surrogate');
	// The save's own state is separate.
	expect(editing.status.kind).toBe('saving');

	expectOk(await editing.waitForSaves());
	expect(await file()).toContain('"title": "Tidy up"');
	expect(editing.status.kind).toBe('saved');
	expect(editing.refusal?.reason).toContain('lone surrogate');
	// It is not unsaved work, and nothing is held for the source to hide.
	expect(editing.holds).toBe(false);
	expect(editing.showSource(true)).toBeUndefined();
	expect(editing.showSource(false)).toBeUndefined();
	expect(editing.refusal?.reason).toContain('lone surrogate');

	typeBody(editing, 'Whole.\n');
	expect(editing.refusal).toBeUndefined();
	expectOk(await editing.waitForSaves());
	expect(await file()).toContain('---\nWhole.\n');
});

test('a refusal outlasts input that is not taken and a reload that fails; a reload, source text, or putting the row down lets it go', async () => {
	const admitted = { value: true };
	const { root, editing } = await open(SEED, { admitted });
	const refuse = () => typeBody(editing, 'Half \uD801.\n');

	refuse();
	admitted.value = false;
	expect(typeField(editing, 'title', 'Not admitted')).toBeUndefined();
	admitted.value = true;
	expect(editing.refusal).toBeDefined();

	await rm(join(root, PATH));
	expect((await editing.reload()).error?.name).toBe('NotFound');
	expect(editing.refusal).toBeDefined();
	await Bun.write(join(root, PATH), SEED);
	expectOk(await editing.reload());
	expect(editing.refusal).toBeUndefined();

	refuse();
	expect(editing.showSource(true)).toBeUndefined();
	editing.setText(sourceShown(editing));
	expect(editing.refusal).toBeUndefined();

	expect(editing.showSource(false)).toBeUndefined();
	refuse();
	editing.release();
	expect(editing.refusal).toBeUndefined();
});

test('a failed save of taken input and a later refusal are both kept; only the taken input is in the row', async () => {
	const { root, editing } = await open();
	await rm(join(root, PATH));
	typeBody(editing, 'First.\n');
	expect((await editing.waitForSaves()).error?.name).toBe('NotFound');

	expect(typeField(editing, 'title', 'Half \uD800')?.error?.name).toBe(
		'Unrepresentable',
	);
	expect(editing.status.kind).toBe('removed');
	expect(editing.refusal).toBeDefined();
	expect(editing.row).toMatchObject({
		body: 'First.\n',
		fields: { title: 'Clean up' },
	});
	// What holds the close is the failed save alone.
	expect(editing.holds).toBe(true);
});

test('nothing is taken while not admitted: input, a view switch, or saving again', async () => {
	const admitted = { value: true };
	const { editing, file } = await open(SEED, { admitted });
	admitted.value = false;

	expect(typeBody(editing, 'Typed during.\n')).toBeUndefined();
	expect(editing.showSource(true)).toContain('Nothing was changed');
	expect(editing.retry()).toContain('Nothing was changed');

	expect(editing.save.status).toBe('idle');
	expect(editing.row.text).toBe(SEED);
	expect(editing.view).toBe('fields');
	expect(await file()).toBe(SEED);
});

test('a malformed file opens in the same editor as its source; typing there is exact and keeps the source shown', async () => {
	const malformed = '---\ntitle: [unclosed\n---\nBody.\n';
	const { editing, file } = await open(malformed);

	expect(editing.view).toBe('source');
	expect(editing.row.status).toBe('invalid');
	// No fields view, so a row typed in a field is not taken.
	expect(
		editing.set({
			fields: { title: 'x', model: null, endpoint: null },
			body: 'Body.\n',
		}),
	).toBeUndefined();
	expect(editing.row.text).toBe(malformed);
	expect(editing.showSource(false)).toContain(
		'still cannot be edited as fields',
	);

	const repaired =
		"---\n# fixed by hand\ntitle: 'Repaired'\nmodel: null\nendpoint: null\n---\nBody.\n";
	editing.setText(repaired);
	expectOk(await editing.waitForSaves());
	expect(await file()).toBe(repaired);
	// Valid now, and the source the person typed in stays shown until they choose.
	expect(editing.row.status).toBe('valid');
	expect(editing.view).toBe('source');
	expect(editing.source).toBe(true);
	// Rows from fields wait for the person to choose them.
	expect(typeField(editing, 'title', 'From a field')).toBeUndefined();
	expect(editing.row.text).toBe(repaired);
	expect(editing.showSource(false)).toBeUndefined();
	expect(editing.view).toBe('fields');
	expect(editing.row).toMatchObject({ fields: { title: 'Repaired' } });
});

test('another writer’s change is not loaded, and the next save writes the whole row over it', async () => {
	const { root, editing, file } = await open();
	const theirs = SEED.replace('Tidy.', 'Theirs.');
	await writeFile(join(root, PATH), theirs);

	expect(editing.row.text).toBe(SEED);
	expect(editing.status.kind).toBe('saved');

	typeBody(editing, 'Mine.\n');
	expectOk(await editing.waitForSaves());
	expect(await file()).toBe(editing.row.text);
	expect(await file()).toContain('Mine.\n');
	expect(await file()).not.toContain('Theirs.');
});

test('a reload takes the file as it is, and takes no input while it reads', async () => {
	const { root, editing, file } = await open();
	const theirs = SEED.replace('Tidy.', 'Theirs.');
	await writeFile(join(root, PATH), theirs);

	const reloading = editing.reload();
	expect(editing.reloading).toBe(true);
	expect(typeBody(editing, 'Typed while it was read.\n')).toBeUndefined();
	expectOk(await reloading);

	expect(editing.reloading).toBe(false);
	expect(editing.row).toMatchObject({ status: 'valid', text: theirs });
	expect(await file()).toBe(theirs);
	expect(editing.holds).toBe(false);
	// Input is taken again once it has read.
	typeBody(editing, 'After.\n');
	expect(editing.row).toMatchObject({ body: 'After.\n' });
});

test('a reload whose file is gone changes nothing, and the next save never creates it', async () => {
	const { root, editing } = await open();
	await rm(join(root, PATH));

	expect((await editing.reload()).error?.name).toBe('NotFound');
	expect(editing.row.text).toBe(SEED);

	typeBody(editing, 'Mine.\n');
	expect((await editing.waitForSaves()).error?.name).toBe('NotFound');
	expect(editing.status.kind).toBe('removed');
	expect(editing.row).toMatchObject({ body: 'Mine.\n' });
	expect(await Bun.file(join(root, PATH)).exists()).toBe(false);
});

test('a row put down takes nothing, and a write it had admitted still settles', async () => {
	const { editing, native, file } = await open();
	typeBody(editing, 'Admitted.\n');

	editing.release();

	expect(editing.view).toBe('released');
	expect(editing.holds).toBe(false);
	expect(typeBody(editing, 'Late.\n')).toBeUndefined();
	expect(editing.retry()).toContain('no longer open');
	expectOk(await native.waitForSaves());
	expect(native.get().save.status).toBe('idle');
	expect(await file()).toContain('Admitted.\n');
	expect(await file()).not.toContain('Late.');
});

test('a missing file keeps input on screen and later typing saves after the file returns', async () => {
	const { root, editing, file } = await open();
	await rm(join(root, PATH));
	typeBody(editing, 'First.\n');
	expect((await editing.waitForSaves()).error?.name).toBe('NotFound');
	expect(editing.row).toMatchObject({ status: 'valid', body: 'First.\n' });
	expect(bodyShown(editing)).toBe('First.\n');
	expect(editing.status.kind).toBe('removed');
	expect(editing.holds).toBe(true);
	await Bun.write(join(root, PATH), SEED);
	typeBody(editing, 'Second.\n');
	expectOk(await editing.waitForSaves());
	expect(await file()).toContain('Second.\n');
});
