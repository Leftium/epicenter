/**
 * Canonical editor (EXPERIMENT)
 *
 * Most tests drive a fake folder whose reads and save replies can be held,
 * so each race happens at an exact moment. The last test runs the same
 * editor over `@epicenter/folder/bun` on a temporary directory.
 *
 * Key behaviors:
 * - watching starts before the first read and ends on dispose or a refused open
 * - an aborted open returns promptly and leaves nothing subscribed
 * - opening refuses missing, unsupported, and schema-invalid files, with the text for repair
 * - subscribers get the current state at once, then each change
 * - local input may be schema invalid; save refuses it and writes nothing
 * - a clean editor follows valid reads; dirty input is never reset
 * - reads are dropped when a save settles under them, and rerun
 * - a lost reply stays unknown even when the file later holds its bytes
 * - adopting a reviewed revision is refused once a newer read replaced it
 */
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder } from '../../src/bun.js';
import { fileCapture, hashBytes } from '../../src/capture.js';
import { defineFolder, defineTable, field } from '../../src/contract.js';
import { FileError } from '../../src/errors.js';
import { inspectSource } from '../../src/table.js';
import {
	type CanonicalEditorFolder,
	type CanonicalEditorState,
	createCanonicalEditors,
} from './canonical-editor.js';

Object.assign(process.env, {
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_TERMINAL_PROMPT: '0',
});

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: {
				title: field.string({ minLength: 1 }),
				done: field.boolean(),
				priority: field.select(['low', 'normal', 'high']),
			},
		}),
	},
});

const PATH = 'todos/plan.md';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A valid row in canonical form, with optional extra fields after the declared ones. */
function row(title: string, body = 'Body.\n', extra = '') {
	return `---\n"title": "${title}"\n"done": false\n"priority": "normal"\n${extra}---\n${body}`;
}

/** A valid row another tool wrote: a comment, an undeclared key, YAML spelling. */
const STYLED = [
	'---',
	'# written by hand',
	'owner: sam',
	'title: Plan',
	'meta: {b: 1, a: [true, null]}',
	'priority: normal',
	'done: false',
	'---',
	'Body A.',
	'',
].join('\n');

async function flush() {
	for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/** A folder whose reads and save replies can be held. Saves hint inside the write, as the Bun folder does. */
function createFakeFolder(initial: string | undefined) {
	let content = initial;
	const listeners = new Set<(paths: readonly string[]) => void>();
	let subscriptions = 0;
	let holdingReads = false;
	const heldReads: PromiseWithResolvers<void>[] = [];
	let reply: PromiseWithResolvers<void> | undefined;
	let loseReply = false;
	let throwOnReply: Error | undefined;
	const writes: string[] = [];
	const hint = () => {
		for (const listener of [...listeners]) listener([PATH]);
	};
	const folder: CanonicalEditorFolder<typeof definition> = {
		tables: {
			todos: {
				inspect: (source) =>
					inspectSource(definition.tables.todos.fields, source),
			},
		},
		files: {
			async read(path) {
				// What the read sees is fixed when it starts.
				const seen = content;
				if (holdingReads) {
					const gate = Promise.withResolvers<void>();
					heldReads.push(gate);
					await gate.promise;
				}
				if (seen === undefined) return FileError.NotFound({ path });
				const bytes = encoder.encode(seen);
				return Ok(
					Object.freeze({ path, sha256: await hashBytes(bytes), bytes }),
				);
			},
			async overwrite(path, data) {
				const text = typeof data === 'string' ? data : decoder.decode(data);
				writes.push(text);
				const sha256 = await hashBytes(encoder.encode(text));
				content = text;
				hint();
				if (reply !== undefined) await reply.promise;
				// A broken port: it should return a Result, never throw.
				if (throwOnReply !== undefined) throw throwOnReply;
				if (loseReply)
					return FileError.Unconfirmed({
						path,
						operation: 'overwrite',
						cause: new Error('the reply was lost'),
					});
				return Ok(fileCapture(path, sha256));
			},
		},
		onFilesChanged(listener) {
			subscriptions += 1;
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return {
		editors: createCanonicalEditors(folder, definition),
		writes,
		disk: () => content,
		watching: () => listeners.size,
		subscriptions: () => subscriptions,
		/** Another writer changes the file and the folder hints. */
		writeElsewhere(text: string | undefined, { hinted = true } = {}) {
			content = text;
			if (hinted) hint();
		},
		holdReads() {
			holdingReads = true;
		},
		heldReads: () => heldReads.length,
		/** Let the oldest held read finish. */
		releaseRead() {
			heldReads.shift()?.resolve();
		},
		releaseReads() {
			holdingReads = false;
			for (const gate of heldReads.splice(0)) gate.resolve();
		},
		holdReply() {
			reply = Promise.withResolvers<void>();
		},
		releaseReply() {
			reply?.resolve();
			reply = undefined;
		},
		loseReplies() {
			loseReply = true;
		},
		/** Make the port throw after the write lands, as a bug would; `undefined` stops it. */
		throwOnReply(error: Error | undefined) {
			throwOnReply = error;
		},
	};
}

async function openPlan(initial: string | undefined = STYLED) {
	const fake = createFakeFolder(initial);
	const editor = expectOk(await fake.editors.tables.todos.edit('plan'));
	return { ...fake, editor };
}

test('watching starts before the first read, so a change during opening is read', async () => {
	const fake = createFakeFolder(row('A'));
	fake.holdReads();
	const opening = fake.editors.tables.todos.edit('plan');
	expect(fake.heldReads()).toBe(1);
	expect(fake.watching()).toBe(1);

	fake.writeElsewhere(row('B'));
	fake.releaseReads();
	const editor = expectOk(await opening);
	// The open read saw A; the hint during it starts the reread that sees B.
	await flush();
	expect(editor.get().document.fields.title).toBe('B');
	expect(editor.get().isDirty).toBe(false);
	await editor.dispose();
	expect(fake.watching()).toBe(0);
});

test('an aborted open returns at once and leaves nothing subscribed', async () => {
	const fake = createFakeFolder(row('A'));
	const before = new AbortController();
	before.abort();
	const early = expectErr(
		await fake.editors.tables.todos.edit('plan', { signal: before.signal }),
	);
	expect(early.name).toBe('Aborted');
	expect(fake.subscriptions()).toBe(0);

	// Navigation: plan is still reading when the person moves to milk.
	fake.holdReads();
	const first = new AbortController();
	const plan = fake.editors.tables.todos.edit('plan', { signal: first.signal });
	expect(fake.watching()).toBe(1);
	first.abort();
	expect(expectErr(await plan).name).toBe('Aborted');
	expect(fake.watching()).toBe(0);

	// The abandoned read finishing later changes nothing.
	fake.releaseReads();
	await flush();
	expect(fake.watching()).toBe(0);
});

test('opening refuses missing, unsupported, and invalid files, keeping the text for repair', async () => {
	const missing = createFakeFolder(undefined);
	expect(expectErr(await missing.editors.tables.todos.edit('plan')).name).toBe(
		'NotFound',
	);
	expect(missing.watching()).toBe(0);

	const tagged = '---\ntitle: !custom Plan\ndone: false\npriority: low\n---\n';
	const unsupported = createFakeFolder(tagged);
	const refusal = expectErr(
		await unsupported.editors.tables.todos.edit('plan'),
	);
	if (refusal.name !== 'UnsupportedSource') throw new Error(refusal.message);
	expect(refusal.file.source).toBe(tagged);
	expect(unsupported.watching()).toBe(0);

	const empty = '---\ntitle: ""\ndone: false\npriority: low\n---\n';
	const invalid = createFakeFolder(empty);
	const issue = expectErr(await invalid.editors.tables.todos.edit('plan'));
	if (issue.name !== 'InvalidSource') throw new Error(issue.message);
	expect(issue.file.source).toBe(empty);
	expect(issue.reading.issues.map((i) => i.field)).toEqual(['title']);

	const badStem = createFakeFolder(row('A'));
	expect(
		expectErr(await badStem.editors.tables.todos.edit('../escape')).name,
	).toBe('InvalidPath');
	expect(badStem.subscriptions()).toBe(0);
});

test('methods work destructured, and subscribers get the current state at once', async () => {
	const { editor, writes } = await openPlan();
	const { get, subscribe, change, save, refresh, adopt, dispose } = editor;

	const first: CanonicalEditorState<unknown>[] = [];
	const second: CanonicalEditorState<unknown>[] = [];
	const stopFirst = subscribe((state) => first.push(state));
	subscribe((state) => second.push(state));
	expect(first).toEqual([get()]);

	expect(change({ fields: { title: 'Plan B' } }).error).toBeNull();
	expect(first.at(-1)).toBe(get());
	stopFirst();
	expect(change({ body: 'New body.\n' }).error).toBeNull();
	expect(first).toHaveLength(2);
	expect(second.at(-1)).toBe(get());

	expect((await save()).error).toBeNull();
	await refresh();
	const latest = get().observation;
	if (latest.kind !== 'present') throw new Error('expected a present read');
	expect(adopt(latest.revision).error).toBeNull();
	await dispose();
	expect(writes).toHaveLength(1);
	expect(get().isDisposed).toBe(true);
});

test('a listener that changes the document on its first call is called again only after it returns', async () => {
	const { editor } = await openPlan(row('A'));
	let depth = 0;
	let maxDepth = 0;
	const titles: unknown[] = [];
	editor.subscribe((state) => {
		depth += 1;
		maxDepth = Math.max(maxDepth, depth);
		titles.push(state.document.fields.title);
		if (titles.length === 1) editor.change({ fields: { title: 'B' } });
		depth -= 1;
	});
	expect(titles).toEqual(['A', 'B']);
	expect(maxDepth).toBe(1);
	await editor.dispose();
});

test('a subscription added during a notification starts after the running listener, once per state', async () => {
	const { editor } = await openPlan(row('A'));
	const order: string[] = [];
	const title = (state: CanonicalEditorState<unknown>) =>
		String(state.document.fields.title);
	let added = false;
	editor.subscribe((state) => {
		order.push(`outer ${title(state)}`);
		if (title(state) !== 'B' || added) return;
		added = true;
		editor.subscribe((inner) => order.push(`inner ${title(inner)}`));
		order.push('subscribed');
	});
	editor.change({ fields: { title: 'B' } });
	editor.change({ fields: { title: 'C' } });
	expect(order).toEqual([
		'outer A',
		'outer B',
		'subscribed',
		'inner B',
		'outer C',
		'inner C',
	]);
	await editor.dispose();
});

test('each subscribe call is its own subscription, stopped by its own function', async () => {
	const { editor } = await openPlan(row('A'));
	const titles: unknown[] = [];
	const listener = (state: CanonicalEditorState<unknown>) =>
		titles.push(state.document.fields.title);
	const stopFirst = editor.subscribe(listener);
	editor.subscribe(listener);
	expect(titles).toEqual(['A', 'A']);
	stopFirst();
	editor.change({ fields: { title: 'B' } });
	expect(titles).toEqual(['A', 'A', 'B']);
	await editor.dispose();
});

test('a listener that disposes when it hears the save waits for that save; disposing again is the same promise', async () => {
	const fake = await openPlan(row('A'));
	const { editor } = fake;
	fake.holdReply();
	editor.change({ fields: { title: 'B' } });
	let disposing: Promise<void> | undefined;
	let again: Promise<void> | undefined;
	editor.subscribe((state) => {
		if (state.saving !== undefined && disposing === undefined)
			disposing = editor.dispose();
		if (state.isDisposed && again === undefined) again = editor.dispose();
	});
	const saving = editor.save();
	if (disposing === undefined) throw new Error('the listener did not dispose');
	expect(again).toBe(disposing);

	let settled = false;
	void disposing.then(() => {
		settled = true;
	});
	await flush();
	expect(settled).toBe(false);
	fake.releaseReply();
	expectOk(await saving);
	await disposing;
	expect(settled).toBe(true);
	expect(editor.get().lastSave?.kind).toBe('saved');
	expect(fake.writes).toEqual([row('B')]);
});

test('a listener that starts the next save when the first settles keeps that admission', async () => {
	const fake = await openPlan(row('A'));
	const { editor } = fake;
	fake.holdReply();
	editor.change({ fields: { title: 'B' } });
	let second: ReturnType<typeof editor.save> | undefined;
	editor.subscribe((state) => {
		if (state.lastSave?.kind !== 'saved' || second !== undefined) return;
		editor.change({ fields: { title: 'C' } });
		fake.holdReply();
		second = editor.save();
	});
	const first = editor.save();
	fake.releaseReply();
	expectOk(await first);
	if (second === undefined) throw new Error('the listener did not save');
	await flush();

	// The first save's continuation did not release the second admission.
	expect(editor.get().saving?.source).toBe(row('C'));
	expect(expectErr(await editor.save()).name).toBe('Saving');
	const disposing = editor.dispose();
	let settled = false;
	void disposing.then(() => {
		settled = true;
	});
	await flush();
	expect(settled).toBe(false);
	fake.releaseReply();
	expectOk(await second);
	await disposing;
	expect(fake.writes).toEqual([row('B'), row('C')]);
});

test('a subscriber that throws does not turn a save that landed into a failure', async () => {
	const { editor } = await openPlan();
	editor.subscribe((state) => {
		if (state.saving !== undefined) throw new Error('a broken view');
	});
	const heard: boolean[] = [];
	editor.subscribe((state) => heard.push(state.saving !== undefined));
	editor.change({ fields: { title: 'Saved anyway' } });
	const receipt = expectOk(await editor.save());
	expect(receipt.document.fields.title).toBe('Saved anyway');
	expect(heard).toContain(true);
	await editor.dispose();
});

test('a save writes the complete document canonically, keeping unknown fields in declared order', async () => {
	const { editor, writes } = await openPlan();
	// Opening a differently formatted file is clean: nothing local changed.
	expect(editor.get().isDirty).toBe(false);
	expect(editor.get().baseline.source).toBe(STYLED);

	editor.change({ fields: { title: 'Plan B' } });
	expect(editor.get().document.fields).toEqual({
		title: 'Plan B',
		done: false,
		priority: 'normal',
		meta: { a: [true, null], b: 1 },
		owner: 'sam',
	});
	const receipt = expectOk(await editor.save());
	const expected =
		'---\n"title": "Plan B"\n"done": false\n"priority": "normal"\n"meta": {"a": [true, null], "b": 1}\n"owner": "sam"\n---\nBody A.\n';
	expect(writes).toEqual([expected]);
	expect(receipt.source).toBe(expected);
	expect(receipt.sha256).toBe(await hashBytes(encoder.encode(expected)));
	expect(editor.get().isDirty).toBe(false);
	await editor.dispose();
});

test('schema-invalid input stays local and visible; save refuses it and writes nothing', async () => {
	const { editor, writes } = await openPlan(row('A'));
	editor.change({ fields: { title: '' } });
	expect(editor.get().document.fields.title).toBe('');
	expect(editor.get().reading.issues.map((i) => i.field)).toEqual(['title']);

	const refused = expectErr(await editor.save());
	expect(refused.name).toBe('InvalidDocument');
	expect(writes).toHaveLength(0);
	expect(editor.get().saving).toBeUndefined();
	expect(editor.get().document.fields.title).toBe('');

	// A value with no canonical form is refused before it reaches the document.
	const nan = expectErr(editor.change({ fields: { done: Number.NaN } }));
	expect(nan.name).toBe('Unrepresentable');
	expect(editor.get().document.fields.done).toBe(false);

	// Removing a declared field, or an option the field does not list, is
	// held the same way.
	editor.change({ fields: { title: 'AB', priority: undefined } });
	expect(editor.get().document.fields).not.toHaveProperty('priority');
	expect(editor.get().reading.issues.map((i) => i.field)).toEqual(['priority']);
	editor.change({ fields: { priority: 'urgent' } });
	expect(editor.get().document.fields.priority).toBe('urgent');
	expect(expectErr(await editor.save()).name).toBe('InvalidDocument');
	expect(writes).toHaveLength(0);

	editor.change({ fields: { priority: 'high' } });
	expect(editor.get().reading.issues).toEqual([]);
	expect((await editor.save()).error).toBeNull();
	expect(writes).toHaveLength(1);
	await editor.dispose();
});

test('the own write read during a held reply is deferred; another writer afterward is followed', async () => {
	const fake = await openPlan(row('A'));
	const { editor } = fake;
	editor.change({ fields: { title: 'B' } });
	fake.holdReply();
	const saving = editor.save();
	await flush();
	// The fake hinted inside the write; that read found the submitted bytes.
	const during = editor.get();
	expect(during.saving?.source).toBe(row('B'));
	expect(during.observation.kind).toBe('present');
	expect(during.baseline.canonical).toBe(row('A'));
	expect(expectErr(await editor.save()).name).toBe('Saving');

	fake.releaseReply();
	const receipt = expectOk(await saving);
	await flush();
	// The reread finds the receipt's own bytes: nothing changed elsewhere.
	expect(editor.get().baseline).toBe(receipt);
	expect(editor.get().isDirty).toBe(false);

	fake.writeElsewhere(row('C'));
	await flush();
	expect(editor.get().document.fields.title).toBe('C');
	expect(editor.get().isDirty).toBe(false);
	await editor.dispose();
});

test('typing during a save survives it and stays dirty against the receipt', async () => {
	const fake = await openPlan(row('A'));
	const { editor } = fake;
	editor.change({ fields: { title: 'B' } });
	fake.holdReply();
	const saving = editor.save();
	editor.change({ fields: { title: 'BC' } });
	fake.releaseReply();
	const receipt = expectOk(await saving);
	await flush();
	expect(receipt.document.fields.title).toBe('B');
	expect(fake.disk()).toBe(row('B'));
	expect(editor.get().document.fields.title).toBe('BC');
	expect(editor.get().isDirty).toBe(true);
	await editor.dispose();
});

test('dirty input is never reset by a read; invalid and missing files keep the document', async () => {
	const fake = await openPlan(row('A'));
	const { editor } = fake;

	fake.writeElsewhere('---\ntitle: !custom X\n---\n');
	await flush();
	expect(editor.get().observation.kind).toBe('unsupported');
	expect(editor.get().document.fields.title).toBe('A');

	fake.writeElsewhere(undefined);
	await flush();
	expect(editor.get().observation.kind).toBe('missing');
	expect(editor.get().document.fields.title).toBe('A');
	expect(editor.get().isDirty).toBe(false);

	// The file comes back: a clean editor follows it.
	fake.writeElsewhere(row('Back'));
	await flush();
	expect(editor.get().document.fields.title).toBe('Back');

	editor.change({ fields: { title: 'Mine' } });
	fake.writeElsewhere(row('Theirs'));
	await flush();
	const { observation, document, isDirty } = editor.get();
	expect(observation.kind === 'present' && observation.revision.canonical).toBe(
		row('Theirs'),
	);
	expect(document.fields.title).toBe('Mine');
	expect(isDirty).toBe(true);

	// Deleted again, then saved: the save recreates the file.
	fake.writeElsewhere(undefined);
	await flush();
	expect(editor.get().observation.kind).toBe('missing');
	expectOk(await editor.save());
	await flush();
	expect(fake.disk()).toBe(row('Mine'));
	expect(editor.get().observation.kind).toBe('present');
	expect(editor.get().isDirty).toBe(false);
	await editor.dispose();
});

test('a read that started before a save settled is dropped and read again', async () => {
	const fake = await openPlan(row('A'));
	const { editor } = fake;
	// X lands without a hint; a read starts and is held with X.
	fake.writeElsewhere(row('X'), { hinted: false });
	fake.holdReads();
	const reading = editor.refresh();
	expect(fake.heldReads()).toBe(1);

	editor.change({ fields: { title: 'L' } });
	expectOk(await editor.save());
	expect(editor.get().isDirty).toBe(false);

	// X predates the write. Applied now, a clean editor would follow it.
	fake.releaseRead();
	await flush();
	expect(editor.get().document.fields.title).toBe('L');
	fake.releaseReads();
	await reading;
	await flush();
	const { observation } = editor.get();
	expect(observation.kind === 'present' && observation.revision.canonical).toBe(
		row('L'),
	);
	expect(editor.get().document.fields.title).toBe('L');
	await editor.dispose();
});

test('a lost reply stays unknown when the file later holds its bytes; the content stops being dirty', async () => {
	const fake = await openPlan(row('A'));
	const { editor } = fake;
	fake.loseReplies();
	editor.change({ fields: { title: 'B' } });
	const lost = expectErr(await editor.save());
	expect(lost.name).toBe('Unconfirmed');
	const { lastSave } = editor.get();
	if (lastSave?.kind !== 'unconfirmed') throw new Error('expected unknown');

	await flush();
	const after = editor.get();
	if (after.observation.kind !== 'present') throw new Error('expected a read');
	// The attempt has no hash of its own; the read is compared by content.
	expect(lastSave.attempt).not.toHaveProperty('sha256');
	expect(after.observation.revision.canonical).toBe(lastSave.attempt.source);
	// The file holds the local content, so nothing is unsaved...
	expect(after.isDirty).toBe(false);
	// ...but which writer put it there is still unknown.
	expect(after.lastSave).toBe(lastSave);
	await editor.dispose();
});

test('a lost reply with newer typing keeps the typing dirty and the outcome unknown', async () => {
	const fake = await openPlan(row('A'));
	const { editor } = fake;
	fake.loseReplies();
	fake.holdReply();
	editor.change({ fields: { title: 'B' } });
	const saving = editor.save();
	editor.change({ fields: { title: 'BC' } });
	fake.releaseReply();
	expect(expectErr(await saving).name).toBe('Unconfirmed');
	await flush();
	expect(editor.get().document.fields.title).toBe('BC');
	expect(editor.get().isDirty).toBe(true);
	expect(editor.get().baseline.canonical).toBe(row('A'));
	expect(editor.get().lastSave?.kind).toBe('unconfirmed');
	await editor.dispose();
});

test('adopting a reviewed revision is refused once a newer read has different content', async () => {
	const fake = await openPlan(row('A'));
	const { editor } = fake;
	editor.change({ fields: { title: 'Mine' } });
	fake.writeElsewhere(row('B'));
	await flush();
	const shown = editor.get().observation;
	if (shown.kind !== 'present') throw new Error('expected B');
	const reviewed = shown.revision;

	// C arrives while the person reviews B.
	fake.writeElsewhere(row('C'));
	await flush();
	const stale = expectErr(editor.adopt(reviewed));
	if (stale.name !== 'Stale') throw new Error(stale.message);
	expect(
		stale.latest.kind === 'present' && stale.latest.revision.canonical,
	).toBe(row('C'));
	expect(editor.get().document.fields.title).toBe('Mine');
	expect(editor.get().isDirty).toBe(true);

	const latest = editor.get().observation;
	if (latest.kind !== 'present') throw new Error('expected C');
	expect(editor.adopt(latest.revision).error).toBeNull();
	expect(editor.get().document.fields.title).toBe('C');
	expect(editor.get().isDirty).toBe(false);
	await editor.dispose();
});

/** `row('Theirs')` as another tool might rewrite it: a comment, other quoting, other order. */
const THEIRS_RESTYLED = [
	'---',
	'# reformatted by another tool',
	"priority: 'normal'",
	'title: Theirs',
	'done: false',
	'---',
	'Body.',
	'',
].join('\n');

test('adopting reviewed content succeeds after a formatting-only rewrite, following the latest revision', async () => {
	const fake = await openPlan(row('A'));
	const { editor } = fake;
	editor.change({ fields: { title: 'Mine' } });
	fake.writeElsewhere(row('Theirs'));
	await flush();
	const shown = editor.get().observation;
	if (shown.kind !== 'present') throw new Error('expected B');
	const reviewed = shown.revision;

	fake.writeElsewhere(THEIRS_RESTYLED);
	await flush();
	const latest = editor.get().observation;
	if (latest.kind !== 'present') throw new Error('expected C');
	expect(latest.revision.sha256).not.toBe(reviewed.sha256);
	expect(latest.revision.canonical).toBe(reviewed.canonical);

	expect(editor.adopt(reviewed).error).toBeNull();
	// The baseline is the latest read, not the reviewed object.
	expect(editor.get().baseline).toBe(latest.revision);
	expect(editor.get().baseline.source).toBe(THEIRS_RESTYLED);
	expect(editor.get().document.fields.title).toBe('Theirs');
	expect(editor.get().isDirty).toBe(false);
	expect(fake.writes).toEqual([]);
	await editor.dispose();
});

test('a supplied revision cannot inject its document, source, or hash through adopt', async () => {
	const fake = await openPlan(row('A'));
	const { editor } = fake;
	editor.change({ fields: { title: 'Mine' } });
	fake.writeElsewhere(THEIRS_RESTYLED);
	await flush();
	const latest = editor.get().observation;
	if (latest.kind !== 'present') throw new Error('expected a read');

	const forged = {
		path: latest.revision.path,
		canonical: latest.revision.canonical,
		sha256: '0'.repeat(64),
		source: '---\n"title": "Injected"\n---\n',
		document: { fields: { title: 'Injected' }, body: 'Injected.\n' },
	};
	expect(editor.adopt(forged).error).toBeNull();
	const after = editor.get();
	expect(after.baseline).toBe(latest.revision);
	expect(after.document).toBe(latest.revision.document);
	expect(after.document.fields.title).toBe('Theirs');
	expect(after.source).toBe(row('Theirs'));
	expect(after.baseline.sha256).toBe(latest.revision.sha256);

	// The same content at another path is not this file's content.
	const elsewhere = { ...forged, path: 'todos/other.md' };
	expect(expectErr(editor.adopt(elsewhere)).name).toBe('Stale');
	expect(fake.writes).toEqual([]);
	await editor.dispose();
});

test('adopting the latest read while a newer read is in flight then follows the newer one', async () => {
	const fake = await openPlan(row('A'));
	const { editor } = fake;
	editor.change({ fields: { title: 'Mine' } });
	fake.writeElsewhere(row('B'));
	await flush();
	const shown = editor.get().observation;
	if (shown.kind !== 'present') throw new Error('expected B');

	fake.holdReads();
	fake.writeElsewhere(row('C'));
	expect(fake.heldReads()).toBe(1);
	expect(editor.adopt(shown.revision).error).toBeNull();
	expect(editor.get().document.fields.title).toBe('B');

	// Now clean, the editor follows the file when the read lands.
	fake.releaseReads();
	await flush();
	expect(editor.get().document.fields.title).toBe('C');
	await editor.dispose();
});

test('dispose stops watching and input; an admitted save still settles; dispose is stable', async () => {
	const fake = await openPlan(row('A'));
	const { editor } = fake;
	const { change, save, dispose, refresh, adopt, get } = editor;
	change({ fields: { title: 'B' } });
	fake.holdReply();
	const saving = save();
	await flush();
	expect(adopt(get().baseline).error?.name).toBe('Saving');

	const disposing = dispose();
	expect(dispose()).toBe(disposing);
	expect(fake.watching()).toBe(0);
	expect(change({ fields: { title: 'C' } }).error?.name).toBe('Disposed');
	expect(expectErr(await save()).name).toBe('Disposed');
	await refresh();

	let disposed = false;
	void disposing.then(() => {
		disposed = true;
	});
	await flush();
	expect(disposed).toBe(false);
	fake.releaseReply();
	expectOk(await saving);
	await disposing;
	expect(get().lastSave?.kind).toBe('saved');
	expect(get().isDisposed).toBe(true);
	expect(fake.writes).toEqual([row('B')]);
});

test('a port that throws is a bug: the save is released, nothing is recorded, and the throw reaches save and dispose', async () => {
	const fake = await openPlan(row('A'));
	const { editor } = fake;
	editor.change({ fields: { title: 'B' } });
	const bug = new Error('a broken port');
	fake.throwOnReply(bug);
	await expect(editor.save()).rejects.toBe(bug);
	await flush();
	expect(editor.get().saving).toBeUndefined();
	expect(editor.get().lastSave).toBeUndefined();
	// The reread after release found the local content on disk: a content
	// fact, not a record that this save landed.
	expect(editor.get().isDirty).toBe(false);

	// Released: the next save is admitted, once, with no retry of the first.
	fake.throwOnReply(undefined);
	expectOk(await editor.save());
	expect(fake.writes).toEqual([row('B'), row('B')]);

	editor.change({ fields: { title: 'C' } });
	fake.throwOnReply(bug);
	fake.holdReply();
	// Handlers attach now; `expect().rejects` would wait before the release.
	const rejection = (promise: Promise<unknown>) =>
		promise.then(
			() => undefined,
			(error: unknown) => error,
		);
	const saving = rejection(editor.save());
	const disposing = rejection(editor.dispose());
	fake.releaseReply();
	expect(await saving).toBe(bug);
	expect(await disposing).toBe(bug);
	await flush();
	expect(editor.get().saving).toBeUndefined();
	expect(editor.get().lastSave?.kind).toBe('saved');
});

test('disposal delivers the admitted save outcome before releasing subscribers', async () => {
	const fake = await openPlan(row('A'));
	const { editor } = fake;
	const heard: string[] = [];
	editor.subscribe((state) => {
		if (state.isDisposed) heard.push(state.lastSave?.kind ?? 'waiting');
	});
	editor.change({ fields: { title: 'B' } });
	fake.holdReply();
	const saving = editor.save();
	await flush();
	const disposing = editor.dispose();
	expect(heard).toEqual(['waiting']);
	fake.releaseReply();
	expectOk(await saving);
	await disposing;
	expect(heard).toEqual(['waiting', 'saved']);
});

test('a terminal subscription gets one snapshot, including subscriptions added during delivery', async () => {
	const { editor } = await openPlan();
	let depth = 0;
	let maximumDepth = 0;
	let nestedCalls = 0;
	editor.subscribe((state) => {
		if (!state.isDisposed) return;
		depth += 1;
		maximumDepth = Math.max(maximumDepth, depth);
		editor.subscribe((terminal) => {
			depth += 1;
			maximumDepth = Math.max(maximumDepth, depth);
			expect(terminal.isDisposed).toBe(true);
			nestedCalls += 1;
			depth -= 1;
		});
		depth -= 1;
	});
	await editor.dispose();
	expect(maximumDepth).toBe(1);
	expect(nestedCalls).toBe(1);
	let calls = 0;
	const unsubscribe = editor.subscribe((state) => {
		expect(state.isDisposed).toBe(true);
		calls += 1;
	});
	unsubscribe();
	unsubscribe();
	await editor.refresh();
	expect(calls).toBe(1);
});

test('over a real folder: open styled source, save canonically, follow another writer', async () => {
	const root = await mkdtemp(
		join(await realpath(tmpdir()), 'epicenter-canonical-editor-test-'),
	);
	const folder = expectOk(
		await openFolder({
			root,
			definition,
			git: {
				author: { name: 'Test', email: 'test@example.test' },
				commitOnEdit: false,
			},
		}),
	);
	try {
		expectOk(await folder.files.create(PATH, STYLED));
		const editors = createCanonicalEditors(folder, definition);
		const editor = expectOk(await editors.tables.todos.edit('plan'));
		const heard: CanonicalEditorState<unknown>[] = [];
		editor.subscribe((state) => heard.push(state));

		editor.change({ fields: { title: 'Plan B', done: true } });
		const receipt = expectOk(await editor.save());
		const disk = await readFile(join(root, PATH), 'utf8');
		expect(disk).toBe(
			'---\n"title": "Plan B"\n"done": true\n"priority": "normal"\n"meta": {"a": [true, null], "b": 1}\n"owner": "sam"\n---\nBody A.\n',
		);
		expect(receipt.source).toBe(disk);
		const snapshot = expectOk(await folder.tables.todos.get('plan'));
		expect(snapshot?.sha256).toBe(receipt.sha256);

		// node:fs is outside the folder, so the reread is requested explicitly.
		await writeFile(join(root, PATH), row('From elsewhere'));
		await editor.refresh();
		expect(editor.get().document.fields.title).toBe('From elsewhere');
		expect(editor.get().isDirty).toBe(false);
		expect(heard.at(-1)).toBe(editor.get());

		await editor.dispose();
	} finally {
		await folder.close();
		await rm(root, { recursive: true, force: true });
	}
});
