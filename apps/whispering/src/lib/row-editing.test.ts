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
 * - every input is the complete row at once: unknown fields stay, a removed
 *   field is deleted, a body keeps its line endings, and the views show LF
 * - nothing is taken while not admitted, while a reload reads the file, or
 *   after the row is put down; a write already admitted still settles
 * - the fields view exists only for a valid row; source typing is exact and
 *   keeps the source shown until the person chooses the fields
 * - another writer's change is not loaded until the person reloads, and
 *   otherwise the next save writes over it
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
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

test('each input is the complete row at once: unknown fields stay, and a removed field is deleted', async () => {
	const { editing, file } = await open();

	editing.setField('title', 'Tidy up');
	editing.setField('model', undefined);
	// The editor's row is the latest input before anything is written.
	expect(editing.save.status).toBe('saving');
	expect(editing.row.text).toBe(
		'---\n"title": "Tidy up"\n"endpoint": null\n"owner": {"name": "me"}\n---\nTidy.\n',
	);

	expectOk(await editing.flush());

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

	editing.setBody('One.\nTwo.\nThree.\n');
	expectOk(await editing.flush());

	expect(await file()).toBe(
		'---\n"title": "Clean up"\n"model": null\n"endpoint": null\n---\nOne.\r\nTwo.\r\nThree.\r\n',
	);
	expect(editing.showSource(true)).toBeUndefined();
	expect(editing.sourceValue()).not.toContain('\r');
	editing.setText(`${editing.sourceValue()}Four.\n`);
	expectOk(await editing.flush());
	expect(await file()).toContain('Three.\r\nFour.\r\n');
});

test('nothing is taken while not admitted: input, a view switch, or saving again', async () => {
	const admitted = { value: true };
	const { editing, file } = await open(SEED, { admitted });
	admitted.value = false;

	editing.setBody('Typed during.\n');
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
	editing.setField('title', 'x');
	expect(editing.row.text).toBe(malformed);
	expect(editing.showSource(false)).toContain(
		'still cannot be edited as fields',
	);

	const repaired =
		"---\n# fixed by hand\ntitle: 'Repaired'\nmodel: null\nendpoint: null\n---\nBody.\n";
	editing.setText(repaired);
	expectOk(await editing.flush());
	expect(await file()).toBe(repaired);
	// Valid now, and the source the person typed in stays shown until they choose.
	expect(editing.row.status).toBe('valid');
	expect(editing.view).toBe('source');
	expect(editing.source).toBe(true);
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

	editing.setBody('Mine.\n');
	expectOk(await editing.flush());
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
	editing.setBody('Typed while it was read.\n');
	expectOk(await reloading);

	expect(editing.reloading).toBe(false);
	expect(editing.row).toMatchObject({ status: 'valid', text: theirs });
	expect(await file()).toBe(theirs);
	expect(editing.holds).toBe(false);
	// Input is taken again once it has read.
	editing.setBody('After.\n');
	expect(editing.row).toMatchObject({ body: 'After.\n' });
});

test('a reload whose file is gone changes nothing, and the next save never creates it', async () => {
	const { root, editing } = await open();
	await rm(join(root, PATH));

	expect((await editing.reload()).error?.name).toBe('NotFound');
	expect(editing.row.text).toBe(SEED);

	editing.setBody('Mine.\n');
	expect((await editing.flush()).error?.name).toBe('NotFound');
	expect(editing.status.kind).toBe('removed');
	expect(editing.row).toMatchObject({ body: 'Mine.\n' });
	expect(await Bun.file(join(root, PATH)).exists()).toBe(false);
});

test('a row put down takes nothing, and a write it had admitted still settles', async () => {
	const { editing, native, file } = await open();
	editing.setBody('Admitted.\n');

	editing.release();

	expect(editing.view).toBe('released');
	expect(editing.holds).toBe(false);
	editing.setBody('Late.\n');
	expect(editing.retry()).toContain('no longer open');
	expect(editing.carry('Carried.\n')).toBe(false);
	expectOk(await native.flush());
	expect(native.get().save.status).toBe('idle');
	expect(await file()).toContain('Admitted.\n');
	expect(await file()).not.toContain('Late.');
});

test('typed values no file can hold are kept per control: a second refusal keeps the first, and repairing or discarding one leaves the other', async () => {
	const { editing, file } = await open();
	const title = 'Half \uD800 a title';
	const body = 'Half \uD801 a body.\n';

	editing.setField('title', title);
	editing.setBody(body);

	// Neither is taken into the row; each control still shows what was typed.
	expect(editing.row.text).toBe(SEED);
	expect(editing.fieldText('title')).toBe(title);
	expect(editing.bodyText()).toBe(body);
	expect(editing.status).toMatchObject({
		kind: 'refused',
		controls: ['title', 'body'],
	});
	expect(editing.holds).toBe(true);
	// The source would hide them, so it is not shown.
	expect(editing.showSource(true)).toContain('Fix or discard');
	expect(editing.view).toBe('fields');

	// Repairing the title takes it and lets go of it alone.
	editing.setField('title', 'Whole title');
	expectOk(await editing.flush());
	expect(await file()).toContain('"title": "Whole title"');
	expect(editing.fieldText('title')).toBe('Whole title');
	expect(editing.bodyText()).toBe(body);
	expect(editing.status).toMatchObject({ kind: 'refused', controls: ['body'] });
	expect(editing.holds).toBe(true);

	// Refused again, then discarded: only that control lets go.
	editing.setField('title', title);
	editing.dropRefused('title');
	expect(editing.fieldText('title')).toBe('Whole title');
	expect(editing.bodyText()).toBe(body);
	expect(editing.holds).toBe(true);

	// A setter of another field does not take the held body.
	editing.setField('model', 'other');
	expectOk(await editing.flush());
	expect(editing.bodyText()).toBe(body);
	expect(await file()).toContain('Tidy.\n');

	// A reload, as the person asks, takes the file and lets go of the rest.
	expectOk(await editing.reload());
	expect(editing.holds).toBe(false);
	expect(editing.bodyText()).toBe('Tidy.\n');
	expect(editing.showSource(true)).toBeUndefined();
});

test('a failed save keeps the latest input on screen, newer typing included, until the person saves again', async () => {
	const { root, editing, file } = await open();
	await rm(join(root, PATH));
	editing.setBody('First.\n');
	expect((await editing.flush()).error?.name).toBe('NotFound');
	editing.setBody('Second.\n');

	expect(editing.row).toMatchObject({ status: 'valid', body: 'Second.\n' });
	expect(editing.bodyText()).toBe('Second.\n');
	expect(editing.status.kind).toBe('removed');
	expect(editing.holds).toBe(true);
	await Bun.write(join(root, PATH), SEED);
	expect(editing.retry()).toBeUndefined();
	expectOk(await editing.flush());
	expect(await file()).toContain('Second.\n');
});

test('carried text lands only in an editor whose saves are idle, shown as its source', async () => {
	const { editing, file } = await open();
	editing.setBody('Own.\n');
	expect(editing.carry(`${SEED}Carried.\n`)).toBe(false);
	expectOk(await editing.flush());

	expect(editing.carry(`${SEED}Carried.\n`)).toBe(true);
	expect(editing.view).toBe('source');
	expectOk(await editing.flush());
	expect(await file()).toBe(`${SEED}Carried.\n`);
});
