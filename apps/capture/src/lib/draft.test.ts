/**
 * Capture Draft Tests
 *
 * Drives the real draft runes module over the folder's real row editor, on a
 * directory folder in a temporary directory. Another program's edits are
 * plain writes to the file.
 *
 * Key behaviors:
 * - Every change submits at once as the complete row: every field, keys
 *   Capture does not declare included, and the body exactly
 * - The latest input saves next; settling waits for it
 * - An open draft keeps what it opened with until the person reloads, and
 *   its next save replaces a change made elsewhere
 * - A file removed elsewhere is never written back; putting it back is an
 *   explicit exclusive create through the same editor
 * - Source saves exactly as typed, frontmatter and malformed text included,
 *   through the one editor; the Capture view returns once the text is valid
 * - A failed save keeps text visible; later input saves and Reload replaces it
 * - An operation that holds the capture takes no input through any path
 * - Restoring preserves the source's BOM, CRLF lines, and Unicode text
 *
 * See also:
 * - `platform/folder.epicenter-host.test.ts` for failed and unconfirmed
 *   saves over a scripted owner
 */
import './svelte-modules.test-support.js';
import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CaptureFields, captureDefinition } from '@epicenter/capture';
import type { RowEditor } from '@epicenter/folder';
import { inspectRow, openFolder } from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';
import type { DraftStore } from './draft.svelte.ts';

const { createDraft } = await import('./draft.svelte.ts');

const roots: string[] = [];
afterAll(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

const PATH = 'captures/one.md';
const AT = '2026-10-01T02:30:00.000Z';
/** The file as another program wrote it. */
const A = `---\ncapturedAt: ${AT}\n---\n\nA\n\n## Thoughts\n\n- first\n- second\n`;
/** The canonical file a save writes for capture text `text`. */
const canon = (text: string, thoughts = '- first\n- second\n') =>
	`---\n"capturedAt": "${AT}"\n---\n\n${text}\n\n## Thoughts\n\n${thoughts}`;
const D = A.replace('\nA\n', '\nD from outside\n');
const INVALID = A.replace(`capturedAt: ${AT}`, 'capturedAt: [open');

async function setup(initial: string | undefined = A) {
	const root = await mkdtemp(join(tmpdir(), 'capture-draft-'));
	roots.push(root);
	const folder = expectOk(
		await openFolder({
			root,
			definition: captureDefinition,
			git: {
				author: { name: 'Test', email: 'test@localhost' },
				commitOnEdit: false,
			},
		}),
	);
	const table = folder.tables.captures;
	const file = join(root, PATH);
	await mkdir(join(root, 'captures'));
	if (initial !== undefined) await writeFile(file, initial);

	/** Every editor the draft acquired, in order. */
	const editors: RowEditor<CaptureFields>[] = [];
	/** Held before the next acquisition reads anything. */
	const next: { edit?: Promise<void> } = {};
	const creates: string[] = [];
	const store: DraftStore = {
		inspect: (text) => inspectRow(captureDefinition.tables.captures, text),
		async edit(signal) {
			const held = next.edit;
			next.edit = undefined;
			await held;
			const opened = await table.edit('one', { signal });
			if (opened.error === null) editors.push(opened.data);
			return opened;
		},
		async read() {
			const found = await table.get('one');
			if (found.error !== null)
				return { kind: 'unreadable', message: found.error.message };
			if (found.data === undefined) return { kind: 'removed' };
			return { kind: 'present', entry: found.data };
		},
		async create(source) {
			creates.push(source);
			const created = await folder.files.create(PATH, source);
			if (created.error !== null) return { data: null, error: created.error };
			const found = expectOk(await table.get('one'));
			if (found === undefined) throw new Error('not read back');
			return { data: found, error: null };
		},
		remove: (reviewed) =>
			table.delete('one', { expectedSha256: reviewed.sha256 }),
		fenced: () => false,
	};
	const draft = createDraft(store, { path: PATH, stem: 'one' });
	await draft.ready;
	return {
		draft,
		editors,
		next,
		store,
		creates,
		disk: () => readFile(file, 'utf8'),
		exists: () => Bun.file(file).exists(),
		outside: (source: string | Uint8Array | undefined) =>
			source === undefined ? rm(file) : writeFile(file, source),
		async done() {
			draft.retire();
			await folder.close();
		},
	};
}

test('typing submits at once as the complete row: every field, unknown ones included, and the body exactly', async () => {
	const withMetadata = `---\n# kept by hand\ncapturedAt: ${AT}\ncustom: 'single quoted'\nnested:\n  list: [1, 2]\n---\n\nA\n\n## Thoughts\n\n- first\n  nested line\n- second\n`;
	const t = await setup(withMetadata);
	// Opening writes nothing and shows the file exactly.
	expect(t.draft.status).toBe('valid');
	expect(t.draft.source).toBe(withMetadata);
	expect(await t.disk()).toBe(withMetadata);

	t.draft.inputText('B, café');
	expect(t.draft.saving).toBe(true);
	expect(t.draft.unsettled).toBe(true);

	expect(await t.draft.settle()).toBe(true);
	expect(await t.disk()).toBe(
		`---\n"capturedAt": "${AT}"\n"custom": "single quoted"\n"nested": {"list": [1, 2]}\n---\n\nB, café\n\n## Thoughts\n\n- first\n  nested line\n- second\n`,
	);
	expect(t.draft.unsettled).toBe(false);
	await t.done();
});

test('typing during a save is shown at once and saved next', async () => {
	const t = await setup();
	t.draft.inputText('B');
	t.draft.inputText('BC');
	expect(t.draft.text).toBe('BC');
	expect(t.draft.saving).toBe(true);
	await t.draft.settle();
	expect(await t.disk()).toBe(canon('BC'));
	expect(t.draft.notice).toBeUndefined();
	expect(t.draft.unsettled).toBe(false);
	await t.done();
});

test('an open draft keeps what it opened with until reloaded, and its next save replaces a change made elsewhere', async () => {
	const t = await setup();
	await t.outside(D);
	expect(t.draft.text).toBe('A');
	expect(t.draft.notice).toBeUndefined();

	expect(await t.draft.reload()).toBe(true);
	expect(t.draft.text).toBe('D from outside');
	expect(await t.disk()).toBe(D);

	await t.outside(A);
	t.draft.inputText('mine');
	await t.draft.settle();
	expect(await t.disk()).toBe(canon('mine'));
	expect(t.creates).toEqual([]);
	expect(t.editors).toHaveLength(1);
	await t.done();
});

test('typing while a reload reads keeps the typing and loads nothing', async () => {
	const t = await setup();
	await t.outside(D);
	const reloading = t.draft.reload();
	t.draft.inputText('typed meanwhile');
	expect(await reloading).toBe(false);
	expect(t.draft.text).toBe('typed meanwhile');
	expect(t.draft.refusal).toContain('typed while the file was being read');
	await t.draft.settle();
	expect(await t.disk()).toBe(canon('typed meanwhile'));
	await t.done();
});

test('a file removed elsewhere is never written back; putting it back is an exclusive create through the same editor', async () => {
	const t = await setup(`\uFEFF${A.replaceAll('\n', '\r\n')}`);
	await t.outside(undefined);
	const source = t.draft.source.replace('\r\nA\r\n', '\r\ncafé 🍊\r\n');
	t.draft.inputSource(source);
	expect(t.draft.source).toBe(source);
	await t.draft.settle();

	expect(t.draft.notice).toMatchObject({ kind: 'failed', missing: true });
	expect(t.draft.source).toBe(source);
	expect(t.draft.unsettled).toBe(true);
	// Neither settling nor Try again creates it.
	t.draft.retry();
	await t.draft.settle();
	expect(await t.exists()).toBe(false);

	expect(await t.draft.restore()).toEqual({ ok: true });
	expect(t.creates).toEqual([source]);
	expect(await t.disk()).toBe(source);
	expect(t.editors).toHaveLength(1);
	expect(t.draft.status).toBe('valid');
	expect(t.draft.notice).toBeUndefined();
	expect(t.draft.unsettled).toBe(false);
	await t.done();
});

test('a reload that finds no file says so and keeps the text; putting it back writes that text', async () => {
	const t = await setup();
	await t.outside(undefined);
	expect(await t.draft.reload()).toBe(false);
	expect(t.draft.notice).toEqual({ kind: 'removed' });
	expect(t.draft.source).toBe(A);
	expect(t.draft.unsettled).toBe(true);

	expect(await t.draft.restore()).toEqual({ ok: true });
	expect(await t.disk()).toBe(A);
	expect(t.draft.notice).toBeUndefined();
	await t.done();
});

test('a file that does not parse opens through the same editor as Source, and Source saves exactly as typed', async () => {
	const t = await setup(INVALID);
	expect(t.draft.status).toBe('invalid');
	expect(t.draft.rowProblem).toBeDefined();
	expect(t.draft.source).toBe(INVALID);
	t.draft.inputNewThought('a thought');
	expect(t.draft.addThought()).toBe(false);
	expect(t.draft.newThought).toBe('a thought');
	t.draft.inputNewThought('');

	const edited = INVALID.replace('\nA\n', '\nA, edited\n');
	t.draft.inputSource(edited);
	await t.draft.settle();
	expect(await t.disk()).toBe(edited);
	expect(t.draft.status).toBe('invalid');
	expect(t.draft.unsettled).toBe(false);

	// A field that needs fixing is described for the text on screen.
	t.draft.inputSource(edited.replace('[open', 'soon'));
	expect(t.draft.reading.parseError).toBeUndefined();
	expect(t.draft.reading.issues.map((issue) => issue.field)).toEqual([
		'capturedAt',
	]);
	t.draft.inputSource(A);
	await t.draft.settle();
	expect(await t.disk()).toBe(A);
	expect(t.draft.status).toBe('valid');
	expect(t.editors).toHaveLength(1);
	await t.done();
});

test('a Source edit saves exactly, frontmatter included; a broken one stays repairable, and later structured saves keep keys Capture does not declare', async () => {
	const t = await setup();
	t.draft.setView('source');
	t.draft.inputSource(t.draft.source.replace('\nA\n', '\nA, in Source\n'));
	await t.draft.settle();
	expect(await t.disk()).toBe(A.replace('\nA\n', '\nA, in Source\n'));

	// Broken frontmatter saves as typed; the Capture view waits for a repair.
	const broken = t.draft.source.replace(`capturedAt: ${AT}`, 'capturedAt: [');
	t.draft.inputSource(broken);
	await t.draft.settle();
	expect(await t.disk()).toBe(broken);
	expect(t.draft.status).toBe('invalid');
	t.draft.inputText('refused');
	expect(t.draft.source).toBe(broken);
	expect(t.draft.refusal).toContain('cannot be edited');

	const withKey = A.replace('\nA\n', '\nA, in Source\n').replace(
		'\n---\n',
		"\n# by hand\n'unknownKey': kept\n---\n",
	);
	t.draft.inputSource(withKey);
	await t.draft.settle();
	// Written exactly as typed: the comment and the quoting stay.
	expect(await t.disk()).toBe(withKey);
	expect(t.draft.status).toBe('valid');

	t.draft.inputText('B');
	await t.draft.settle();
	expect(await t.disk()).toBe(
		canon('B').replace('\n---\n\n', '\n"unknownKey": "kept"\n---\n\n'),
	);
	// Choosing a view changes nothing saved.
	t.draft.setView('capture');
	expect(t.draft.unsettled).toBe(false);
	expect(t.editors).toHaveLength(1);
	await t.done();
});

test('unsent thought text is unsettled, but rejected capture text leaves accepted content and no unsent input', async () => {
	const t = await setup();
	expect(t.draft.unsettled).toBe(false);
	t.draft.inputNewThought('not added yet');
	expect(t.draft.unsettled).toBe(true);
	expect(await t.draft.settle()).toBe(false);
	expect(t.draft.addThought()).toBe(true);
	expect(t.draft.newThought).toBe('');
	await t.draft.settle();
	expect(await t.disk()).toBe(
		canon('A', '- first\n- second\n- not added yet\n'),
	);
	expect(t.draft.unsettled).toBe(false);

	// An unclosed fence would absorb the section: the attempted edit is rolled back.
	t.draft.inputText('A\n```\nopen');
	expect(t.draft.text).toBe('A');
	expect(t.draft.refusal).toContain('would not read back');
	expect(t.draft.saving).toBe(false);
	expect(t.draft.unsettled).toBe(false);
	expect(t.draft.hasUnsentInput).toBe(false);
	t.draft.inputText('A\n```\nopen\n```');
	expect(t.draft.refusal).toBeUndefined();
	expect(t.draft.document.text).toBe('A\n```\nopen\n```');
	await t.done();
});

test('Source saves unfinished Markdown exactly and repairs it without losing the existing thoughts', async () => {
	const t = await setup();
	t.draft.inputText('A\n```\nopen');
	expect(t.draft.text).toBe('A');
	t.draft.setView('source');
	const unfinished = A.replace('\nA\n', '\nA\n```\nopen\n');
	t.draft.inputSource(unfinished);
	await t.draft.settle();
	expect(await t.disk()).toBe(unfinished);
	expect(t.draft.document.thoughts).toEqual([]);
	// Closing the fence in Capture would claim to have no thoughts, so the codec refuses it.
	t.draft.inputText(t.draft.text.replace('\nopen\n', '\nopen\n```\n'));
	expect(t.draft.refusal).toBeDefined();
	expect(t.draft.source).toBe(unfinished);
	const repaired = unfinished.replace('\nopen\n', '\nopen\n```\n');
	t.draft.inputSource(repaired);
	await t.draft.settle();
	expect(await t.disk()).toBe(repaired);
	expect(t.draft.document.thoughts).toEqual(['first', 'second']);
	expect(t.draft.refusal).toBeUndefined();
	await t.done();
});

test('a failed save keeps input visible and later corrected text saves again', async () => {
	const t = await setup();
	t.draft.setView('source');
	const lone = t.draft.source.replace('\nA\n', '\nlone \uD800\n');
	t.draft.inputSource(lone);
	await t.draft.settle();
	// Accepted and shown, and its save failed instead of writing other bytes.
	expect(t.draft.source).toBe(lone);
	expect(t.draft.notice?.kind).toBe('failed');
	expect(await t.disk()).toBe(A);

	const fixed = A.replace('\nA\n', '\nfixed\n');
	t.draft.inputSource(fixed);
	await t.draft.settle();
	expect(t.draft.source).toBe(fixed);
	expect(t.draft.notice).toBeUndefined();
	expect(await t.disk()).toBe(fixed);
	await t.done();
});

test('Reload after a failed save drops the failed text and shows the file', async () => {
	const t = await setup();
	t.draft.inputSource(t.draft.source.replace('\nA\n', '\nlone \uD800\n'));
	await t.draft.settle();
	expect(t.draft.notice?.kind).toBe('failed');
	await t.outside(D);

	expect(await t.draft.reload()).toBe(true);
	expect(t.draft.notice).toBeUndefined();
	expect(t.draft.source).toBe(D);
	expect(t.draft.unsettled).toBe(false);
	expect(await t.disk()).toBe(D);
	expect(t.editors).toHaveLength(1);
	await t.done();
});

test('a capture held by an operation takes no input and submits nothing through any path', async () => {
	const t = await setup();
	t.draft.inputNewThought('kept');
	expect(await t.draft.reviewDeletion()).toBe(true);
	expect(t.draft.deletionReview?.entry.text).toBe(A);
	expect(t.draft.operation).toBe('deleting');
	expect(t.draft.admitted).toBe(false);

	const source = t.draft.source;
	t.draft.inputText('typed during the delete');
	t.draft.inputNewThought('typed during the delete');
	t.draft.inputSource(`${source}typed during the delete\n`);
	expect(t.draft.addThought()).toBe(false);
	t.draft.retry();
	t.draft.setView('source');
	expect(await t.draft.reload()).toBe(false);
	expect(t.draft.text).toBe('A');
	expect(t.draft.newThought).toBe('kept');
	expect(t.draft.source).toBe(source);
	expect(t.draft.view).toBe('capture');
	expect(t.draft.refusal).toContain('being deleted');
	expect(t.editors).toHaveLength(1);
	await t.draft.settle();
	expect(await t.disk()).toBe(A);

	t.draft.cancelDeletion();
	t.draft.inputText('after');
	expect(t.draft.text).toBe('after');
	await t.done();
});

test('a draft let go while its editor opens takes no editor and saves nothing', async () => {
	const t = await setup();
	t.draft.retire();
	const opening = Promise.withResolvers<void>();
	t.next.edit = opening.promise;
	const late = createDraft(t.store, { path: PATH, stem: 'one' });
	late.inputNewThought('typed while opening');
	late.retire();
	opening.resolve();
	await late.ready;

	expect(late.status).toBeUndefined();
	expect(late.loaded).toBe(false);
	expect(late.retired).toBe(true);
	late.inputText('after');
	expect(late.addThought()).toBe(false);
	expect(await t.disk()).toBe(A);
	await t.done();
});

test('opening an unchanged thought is settled; typing and reverting derive its unsent state', async () => {
	const t = await setup();
	try {
		t.draft.startEditing(0);
		const edit = t.draft.editing?.id;
		if (edit === undefined) throw new Error('fixture');
		expect(t.draft.hasUnsentInput).toBe(false);
		expect(t.draft.unsettled).toBe(false);
		t.draft.inputEditing('first\n', edit);
		expect(t.draft.hasUnsentInput).toBe(true);
		expect(t.draft.unsettled).toBe(true);
		t.draft.inputEditing('first', edit);
		expect(t.draft.hasUnsentInput).toBe(false);
		expect(t.draft.unsettled).toBe(false);
		t.draft.inputSource(A.replace('- first', '- changed'));
		expect(t.draft.hasUnsentInput).toBe(true);
	} finally {
		await t.done();
	}
});

test('positions select one duplicate thought for editing and deletion', async () => {
	const t = await setup();
	try {
		t.draft.inputSource(A.replace('- second', '- first'));
		t.draft.startEditing(1);
		const edit = t.draft.editing?.id;
		if (edit === undefined) throw new Error('fixture');
		t.draft.inputEditing('second occurrence', edit);
		expect(t.draft.commitEditing(edit)).toBe(true);
		expect(t.draft.document.thoughts).toEqual(['first', 'second occurrence']);
		t.draft.inputSource(A.replace('- second', '- first'));
		expect(t.draft.deleteThought(1)).toBe(true);
		expect(t.draft.document.thoughts).toEqual(['first']);
	} finally {
		await t.done();
	}
});

test('reading changed input invalidates an earlier thought edit even when the original text returns', async () => {
	const t = await setup();
	try {
		const first = t.draft.document.thoughts[0];
		if (first === undefined) throw new Error('fixture');
		t.draft.startEditing(0);
		const edit = t.draft.editing?.id;
		if (edit === undefined) throw new Error('fixture');
		t.draft.inputEditing('kept correction', edit);
		const native = t.editors[0];
		if (native === undefined) throw new Error('fixture');
		native.setText(D);
		expect(t.draft.reading.parseError).toBeUndefined();
		native.setText(A);
		expect(t.draft.commitEditing(edit)).toBe(false);
		expect(t.draft.editing?.text).toBe('kept correction');
		expect(t.draft.refusal).toContain('changed since this thought was shown');
	} finally {
		await t.done();
	}
});

test('a thought edit begun before the document changed is refused and its text kept', async () => {
	const t = await setup();
	const shown = t.draft.document.thoughts;
	const [first, second] = shown;
	if (!first || !second) throw new Error('fixture');
	t.draft.startEditing(1);
	const earlier = t.draft.editing?.id;
	if (earlier === undefined) throw new Error('fixture');
	t.draft.cancelEditing(earlier);
	t.draft.startEditing(0);
	const edit = t.draft.editing?.id;
	if (edit === undefined) throw new Error('fixture');
	// Only the edit open now takes text, is saved, or is cancelled.
	t.draft.inputEditing('not this one', earlier);
	expect(t.draft.editing?.text).toBe('first');
	expect(t.draft.commitEditing(earlier)).toBe(false);
	t.draft.cancelEditing(earlier);
	expect(t.draft.editing?.id).toBe(edit);
	t.draft.inputEditing('first, edited', edit);
	// Something else changes the document: a different parse.
	t.draft.inputText('A changed');
	expect(t.draft.commitEditing(edit)).toBe(false);
	expect(t.draft.editing?.text).toBe('first, edited');
	expect(t.draft.refusal).toContain('changed since this thought was shown');
	expect(t.draft.document.thoughts).toEqual(['first', 'second']);
	// Delayed positional commands must still name the list they showed.
	expect(t.draft.deleteThought(0, shown)).toBe(false);
	expect(t.draft.swapThoughts(0, 1, shown)).toBe(false);
	expect(t.draft.swapThoughts(0, 1)).toBe(true);
	expect(t.draft.document.thoughts).toEqual(['second', 'first']);
	await t.done();
});
