/**
 * Native data reads under real Svelte effects.
 * Table, KV, and persistence changes wake readers without caching values.
 * Reads share native transaction visibility and closed-store admission.
 * Subscriptions attach only while effects read, including across remounts.
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { flushSync, tick } from 'svelte';
import { expectOk } from 'wellcrafted/testing';

const { defineStore, defineTable, field, plainText } = await import(
	'../../app/src/index.ts'
);
const { openMemory } = await import('../../app/src/data/store/memory.ts');
const { fromData } = await import('./from-data.svelte.ts');
const { fromKv } = await import('./from-kv.svelte.ts');
const { watch } = await import('./effects.test-support.svelte.ts');

const definition = defineStore({
	id: 'test.reactive-reads',
	kv: { theme: field.select(['dark', 'light']) },
	tables: {
		notes: defineTable({
			fields: { title: field.string() },
			body: plainText(),
		}),
		folders: defineTable({ fields: { name: field.string() } }),
	},
});

async function setup() {
	const data = await openMemory(definition);
	data.kv.update({ theme: 'dark' });
	data.tables.notes.create({ title: 'first' });
	await data.persistence.flush();
	return data;
}

/** Each value produced by a real effect; disposal stops its reader. */
function observe<T>(read: () => T) {
	const seen: T[] = [];
	const stop = watch(() => {
		seen.push(read());
	});
	flushSync();
	return { seen, stop, last: () => seen.at(-1), [Symbol.dispose]: stop };
}

test('native names, row types, writes, and capability identities survive wrapping', async () => {
	await using data = await setup();
	const ui = fromData(data);
	expect(Object.keys(ui.tables).sort()).toEqual(['folders', 'notes']);
	const titles: string[] = ui.tables.notes.rows.map((row) => row.title);
	expect(titles).toEqual(['first']);
	expect(ui.tables.folders.rows).toEqual([]);
	expect(ui.transact).toBe(data.transact);
	expect(ui.onCommitted).toBe(data.onCommitted);
	expect(ui.persistence.flush).toBe(data.persistence.flush);
	expect(ui.tables.notes.create).toBe(data.tables.notes.create);
	expect(fromData(data)).toBe(ui);
	expect(fromKv(data.kv)).toBe(ui.kv);
	const note = ui.tables.notes.create({ title: 'made' });
	expectOk(ui.tables.notes.update(note.id, { title: 'renamed' }));
	expect(data.tables.notes.get(note.id)?.title).toBe('renamed');
	ui.tables.notes.delete(note.id);
	expect(data.tables.notes.get(note.id)).toBeUndefined();
});

test('all table reads follow edits, unreadable rows, repair, and deletion', async () => {
	await using data = await setup();
	const raw = data.tables.notes;
	const note = raw.rows[0];
	assert(note);
	const table = fromData(data).tables.notes;
	using ids = observe(() => table.ids());
	using rows = observe(() => table.rows.map((row) => row.title));
	using point = observe(() => table.get(note.id)?.title);
	using issues = observe(() => table.nonconforming.map((row) => row.id));
	using body = observe(() => table.body(note.id));
	const original = body.last();
	assert(original);

	expectOk(raw.update(note.id, { title: 'renamed' }));
	flushSync();
	expect(point.last()).toBe('renamed');
	expect(rows.last()).toEqual(['renamed']);
	expect(ids.last()).toEqual(raw.ids());
	assert(original.parent);
	original.parent.setAttr('title', 42);
	flushSync();
	expect(point.last()).toBeUndefined();
	expect(rows.last()).toEqual([]);
	expect(issues.last()).toEqual([note.id]);
	expect(ids.last()).toEqual([note.id]);
	expect(body.last()).toBe(original);
	expectOk(raw.update(note.id, { title: 'repaired' }));
	flushSync();
	expect(point.last()).toBe('repaired');
	expect(issues.last()).toEqual([]);
	raw.delete(note.id);
	flushSync();
	expect(rows.last()).toEqual([]);
	expect(ids.last()).toEqual([]);
	expect(body.last()).toBeUndefined();
});

test('an already unreadable row remains visible to IDs, diagnostics, and body reads', async () => {
	await using data = await setup();
	const raw = data.tables.notes;
	const note = raw.rows[0];
	assert(note);
	const original = raw.body(note.id);
	assert(original);
	assert(original.parent);
	original.parent.setAttr('title', 42);
	const table = fromData(data).tables.notes;
	using ids = observe(() => table.ids());
	expect(ids.last()).toEqual([note.id]);
	expect(table.rows).toEqual([]);
	expect(table.nonconforming.map((row) => row.id)).toEqual([note.id]);
	expect(table.body(note.id)).toBe(original);
	raw.delete(note.id);
	flushSync();
	expect(ids.last()).toEqual([]);
});

test('native malformed body structure and repair wake body readers', async () => {
	await using data = await setup();
	const raw = data.tables.notes;
	const note = raw.rows[0];
	assert(note);
	const table = fromData(data).tables.notes;
	const body = raw.body(note.id);
	assert(body?.parent);
	using observed = observe(() => table.body(note.id));
	body.parent.insert(1, ['extra child']);
	flushSync();
	expect(observed.last()).toBeUndefined();
	body.parent.delete(1, 1);
	flushSync();
	expect(observed.seen).toEqual([body, undefined, body]);
});

test('KV value and diagnostic readers follow valid and invalid writes', async () => {
	await using data = await setup();
	const kv = fromKv(data.kv);
	using theme = observe(() => kv.get('theme'));
	using issues = observe(() => kv.nonconforming.length);
	kv.update({ theme: 'light' });
	flushSync();
	expect(theme.seen).toEqual(['dark', 'light']);
	// External data can violate a declaration; KV writes do not validate.
	data.kv.update({ theme: 42 } as never);
	flushSync();
	expect(theme.last()).toBeUndefined();
	expect(issues.seen).toEqual([0, 0, 1]);
});

test('persistence status tracks native writes and flush completion', async () => {
	await using data = await setup();
	const ui = fromData(data);
	using status = observe(() => ui.persistence.get());
	data.tables.notes.create({ title: 'unsaved' });
	flushSync();
	expect(status.last()).toBe('pending');
	await ui.persistence.flush();
	flushSync();
	expect(status.last()).toBe('saved');
});

test('table subscriptions are lazy, shared, and detached across reader lifetimes', async () => {
	await using data = await setup();
	const raw = data.tables.notes;
	let active = 0;
	let reads = 0;
	const ui = fromData({
		...data,
		tables: {
			...data.tables,
			notes: {
				...raw,
				get rows() {
					reads += 1;
					return raw.rows;
				},
				subscribe(listener: Parameters<typeof raw.subscribe>[0]) {
					active += 1;
					const stop = raw.subscribe(listener);
					return () => {
						active -= 1;
						stop();
					};
				},
			},
		},
	});
	expect(reads).toBe(0);
	expect(active).toBe(0);
	ui.tables.notes.rows;
	expect(reads).toBe(1);
	expect(active).toBe(0);
	const first = observe(() => ui.tables.notes.rows.length);
	const second = observe(() => ui.tables.notes.ids());
	expect(active).toBe(1);
	first.stop();
	await tick();
	expect(active).toBe(1);
	second.stop();
	await tick();
	expect(active).toBe(0);
	raw.create({ title: 'while away' });
	using remounted = observe(() => ui.tables.notes.rows.length);
	expect(remounted.last()).toBe(2);
	expect(active).toBe(1);
});

test.each([
	'kv',
	'persistence',
] as const)('%s subscriptions attach only for readers, detach, and see changes on remount', async (source) => {
	await using data = await setup();
	let active = 0;
	let subscriptions = 0;
	const native = data[source];
	const counted = {
		...native,
		subscribe(listener: () => void) {
			subscriptions += 1;
			active += 1;
			const stop = native.subscribe(listener);
			return () => {
				active -= 1;
				stop();
			};
		},
	};
	const ui = fromData({ ...data, [source]: counted });
	const read = () =>
		source === 'kv' ? ui.kv.get('theme') : ui.persistence.get();
	const initial = source === 'kv' ? 'dark' : 'saved';
	const changed = source === 'kv' ? 'light' : 'pending';
	expect(read()).toBe(initial);
	expect(subscriptions).toBe(0);
	using first = observe(read);
	using second = observe(read);
	expect(subscriptions).toBe(1);
	expect(active).toBe(1);
	first.stop();
	await tick();
	expect(active).toBe(1);
	second.stop();
	await tick();
	expect(active).toBe(0);
	if (source === 'kv') data.kv.update({ theme: 'light' });
	else data.tables.notes.create({ title: 'while away' });
	flushSync();
	expect(first.seen).toEqual([initial]);
	expect(second.seen).toEqual([initial]);
	using remounted = observe(read);
	expect(remounted.last()).toBe(changed);
	expect(subscriptions).toBe(2);
	expect(active).toBe(1);
	remounted.stop();
	await tick();
	expect(active).toBe(0);
});

test('stores opened from one definition have independent reactive values and subscriptions', async () => {
	await using local = await setup();
	await using other = await setup();
	const localUi = fromData(local);
	const otherUi = fromData(other);
	using localRows = observe(() =>
		localUi.tables.notes.rows.map((row) => row.title),
	);
	using otherRows = observe(() =>
		otherUi.tables.notes.rows.map((row) => row.title),
	);
	using localTheme = observe(() => localUi.kv.get('theme'));
	using otherTheme = observe(() => otherUi.kv.get('theme'));
	local.tables.notes.create({ title: 'local only' });
	local.kv.update({ theme: 'light' });
	flushSync();
	expect(localRows.last()?.toSorted()).toEqual(['first', 'local only']);
	expect(otherRows.seen).toEqual([['first']]);
	expect(localTheme.seen).toEqual(['dark', 'light']);
	expect(otherTheme.seen).toEqual(['dark']);
});

test('reactive reads share native transaction and commit-callback visibility', async () => {
	await using data = await setup();
	const raw = data.tables.notes;
	const note = raw.rows[0];
	assert(note);
	const table = fromData(data).tables.notes;
	const seen: (string | undefined)[] = [];
	const stop = data.onCommitted(() => {
		seen.push(table.get(note.id)?.title);
	});
	try {
		data.transact(() => {
			expectOk(raw.update(note.id, { title: 'during' }));
			expect(table.get(note.id)?.title).toBe('during');
		});
		expect(seen).toEqual(['during']);
	} finally {
		stop();
	}
});

test('all reactive read methods preserve native closed-store rejection', async () => {
	const data = await setup();
	const ui = fromData(data);
	const id = data.tables.notes.ids()[0];
	assert(id);
	await data[Symbol.asyncDispose]();
	for (const read of [
		() => ui.tables.notes.rows,
		() => ui.tables.notes.ids(),
		() => ui.tables.notes.get(id),
		() => ui.tables.notes.body(id),
		() => ui.tables.notes.nonconforming,
		() => ui.kv.get('theme'),
		() => ui.kv.nonconforming,
		() => ui.persistence.get(),
	])
		expect(read).toThrow();
});

test('own descriptors survive and unsupported class handles fail explicitly', async () => {
	await using data = await setup();
	let revision = 0;
	const source = { ...data.kv };
	Object.defineProperty(source, 'update', {
		value: data.kv.update,
		enumerable: false,
	});
	Object.defineProperty(source, 'revision', { get: () => ++revision });
	const kv = fromKv(
		Object.freeze(source) as typeof source & { readonly revision: number },
	);
	expect(revision).toBe(0);
	expect(kv.revision).toBe(1);
	expect(kv.revision).toBe(2);
	expect(kv.update).toBe(data.kv.update);
	class UnsupportedKv {
		get(_key: never) {
			return undefined;
		}
		get nonconforming() {
			return [];
		}
		subscribe(_listener: () => void) {
			return () => {};
		}
		update() {}
	}
	expect(() => fromKv(new UnsupportedKv())).toThrow('plain-object');
});
