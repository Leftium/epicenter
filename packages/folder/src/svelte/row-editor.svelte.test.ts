/**
 * Row Editor Svelte Tests
 *
 * Mounts compiled `.svelte` fixtures in jsdom over a real `table.edit` owner
 * whose storage the test drives, and types through the DOM. This proves
 * Svelte tracking, function bindings, conditional views, and subscription
 * lifetimes; it says nothing about layout, focus, selection, IME, or real
 * storage latency.
 *
 * Key behaviors:
 * - getters read the owner's snapshot; only effects subscribe, once, and never read the file
 * - bound fields show the latest accepted input while writes are pending
 * - structured edits submit the latest complete row, unknown metadata included
 * - textareas show LF and write back the file's CRLF
 * - outside changes appear only after Reload; a failed Reload keeps the view and input
 * - a raw view leaving after Reload admits nothing
 * - unmounting or switching owners ends the subscription, never publication
 * - `set` owns a `$state` draft's values before it returns
 * - a failure shows until the next input saves; Retry saves the same text again
 *
 * See also:
 * - `../editor.test.ts` for the owner's writes, waitForSaves, and reload rules
 */
import { expect, test } from 'bun:test';
import type { Component } from 'svelte';
import { parseCanonicalDocument } from '../canonical.js';
import { FileError } from '../errors.js';
import { openTodo, settle, todo } from './row-storage.test-support.js';
import { click, finishAnimations, type } from './svelte-dom.test-support.js';

const { flushSync, mount, tick, unmount } = await import('svelte');
const { fromRowEditor } = await import('./row-editor.svelte.ts');
const { default: RowView } = await import('./fixtures/RowView.svelte');
const { default: DraftForm } = await import('./fixtures/DraftForm.svelte');
const { default: DraftHost } = await import('./fixtures/DraftHost.svelte');
const { switchable } = await import('./switchable.test-support.svelte.ts');

const READ_FAILURE = FileError.Io({
	path: 'todos/plan.md',
	operation: 'read',
	cause: 'the disk went away',
}).error;

// biome-ignore lint/suspicious/noExplicitAny: fixtures declare their own props
function render(component: Component<any>, props: Record<string, unknown>) {
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(component, { target, props });
	flushSync();
	let mounted = true;
	const destroy = () => {
		if (!mounted) return;
		mounted = false;
		void unmount(view);
		target.remove();
	};
	return {
		target,
		get<T extends Element = HTMLTextAreaElement>(selector: string): T {
			const element = target.querySelector(selector);
			if (element === null) throw new Error(`Nothing matches '${selector}'`);
			return element as unknown as T;
		},
		has: (selector: string) => target.querySelector(selector) !== null,
		text: (selector: string) =>
			target.querySelector(selector)?.textContent ?? undefined,
		destroy,
		[Symbol.dispose]: destroy,
	};
}

/** Count assignments to a textarea's `value` from now on, keeping their effect. */
function countValueAssignments(element: HTMLTextAreaElement) {
	const { get, set } =
		Object.getOwnPropertyDescriptor(
			Object.getPrototypeOf(element) as object,
			'value',
		) ?? {};
	if (get === undefined || set === undefined)
		throw new Error('The textarea has no value accessor');
	let count = 0;
	Object.defineProperty(element, 'value', {
		configurable: true,
		get() {
			return get.call(element);
		},
		set(value: string) {
			count += 1;
			set.call(element, value);
		},
	});
	return () => count;
}

function fieldsOf(text: string | undefined) {
	const { data, error } = parseCanonicalDocument(text ?? '');
	if (error !== null) throw new Error(error.reason);
	return data;
}

test('reads outside effects subscribe to nothing; mounted views share one subscription until the last unmounts', async () => {
	const fake = await openTodo();
	const { editor } = fake;
	const reactive = fromRowEditor(editor);
	expect(fromRowEditor(editor)).toBe(reactive);
	expect(Object.keys(reactive)).toEqual([
		'row',
		'save',
		'set',
		'setText',
		'retry',
		'waitForSaves',
		'reload',
	]);
	expect(reactive.set).toBe(editor.set);
	expect(reactive.setText).toBe(editor.setText);
	expect(reactive.retry).toBe(editor.retry);
	expect(reactive.waitForSaves).toBe(editor.waitForSaves);
	expect(reactive.reload).toBe(editor.reload);
	expect(reactive.row).toBe(editor.get().row);
	expect(reactive.save).toBe(editor.get().save);
	await settle();
	expect(fake.subscriptions()).toBe(0);

	const first = render(RowView, { rowEditor: editor });
	const second = render(RowView, { rowEditor: editor });
	expect(fake.subscriptions()).toBe(1);

	first.destroy();
	await settle();
	expect(fake.subscriptions()).toBe(1);
	second.destroy();
	await settle();
	expect(fake.subscriptions()).toBe(0);
	// Subscribing read nothing: the only read was acquisition's.
	expect(fake.reads()).toBe(1);

	// Reads follow the owner and nothing was copied.
	editor.setText(todo('Later'));
	expect(reactive.row).toBe(editor.get().row);
	expect(reactive.save).toBe(editor.get().save);
	expect(fake.subscriptions()).toBe(0);
});

test('a bound textarea shows the latest accepted text through delayed publication, and raw mode stays until Edit fields', async () => {
	const fake = await openTodo('no frontmatter\n');
	const { editor } = fake;
	fake.holdReplies();
	using view = render(RowView, { rowEditor: editor });
	expect(view.text('[data-view="row-failure"]')).toBe('NoCanonicalForm');
	const source = view.get('textarea');
	expect(source.value).toBe('no frontmatter\n');

	type(source, 'A');
	flushSync();
	type(source, 'B');
	flushSync();
	type(source, todo('C'));
	flushSync();
	await settle();
	// A is active, C replaced B as pending, and the field shows C.
	expect(fake.heldReplies()).toBe(1);
	expect(source.value).toBe(todo('C'));
	expect(editor.get().row.status).toBe('valid');
	// Valid text keeps the raw view the person chose, in the same node.
	expect(view.get('textarea')).toBe(source);
	expect(view.has('[data-view="row-failure"]')).toBe(false);
	expect(view.text('button')).toBe('Edit fields');

	// A's late receipt does not replace C.
	fake.releaseReply();
	await settle();
	flushSync();
	expect(source.value).toBe(todo('C'));
	expect(editor.get().save.status).toBe('saving');
	fake.releaseReplies();
	await settle();
	flushSync();
	expect(fake.writes).toEqual(['A', todo('C')]);
	expect(editor.get().save.status).toBe('idle');
	expect(source.value).toBe(todo('C'));

	click(view.target, 'Edit fields');
	flushSync();
	expect(view.has('textarea[aria-label="Markdown source"]')).toBe(false);
	expect(view.get<HTMLInputElement>('input[aria-label="Title"]').value).toBe(
		'C',
	);
});

test('structured fields submit the latest complete row: unknown metadata and body survive, and a refusal keeps the accepted value', async () => {
	const styled = [
		'---',
		'owner: sam',
		'title: Plan',
		'meta: {b: 1, a: [true, null]}',
		'done: false',
		'---',
		'Body A.',
		'',
	].join('\n');
	const fake = await openTodo(styled);
	const { editor } = fake;
	using view = render(RowView, { rowEditor: editor });
	const title = view.get<HTMLInputElement>('input[aria-label="Title"]');
	const body = view.get('textarea[aria-label="Body"]');
	expect(title.value).toBe('Plan');

	// A lone surrogate has no canonical form: nothing is accepted, and the
	// binding shows the accepted title again rather than clearing the field.
	type(title, 'Plan \uD800');
	await tick();
	flushSync();
	expect(view.text('[data-view="refusal"]')).toContain('lone surrogate');
	expect(title.value).toBe('Plan');
	expect(editor.get().row).toMatchObject({ text: styled });
	expect(editor.get().save.status).toBe('idle');

	fake.holdReplies();
	type(title, 'Plan 2');
	flushSync();
	// The body edit starts from the accepted title, not the file.
	type(body, 'Body B.\n');
	flushSync();
	expect(title.value).toBe('Plan 2');
	fake.releaseReplies();
	await settle();
	flushSync();

	expect(fake.writes).toHaveLength(2);
	const kept = { owner: 'sam', meta: { b: 1, a: [true, null] }, done: false };
	expect(fieldsOf(fake.writes[0])).toEqual({
		fields: { ...kept, title: 'Plan 2' },
		body: 'Body A.\n',
	});
	expect(fieldsOf(fake.writes[1])).toEqual({
		fields: { ...kept, title: 'Plan 2' },
		body: 'Body B.\n',
	});
	expect(title.value).toBe('Plan 2');
	expect(body.value).toBe('Body B.\n');
});

test('a shared bindable textarea component binds the same getter and setter', async () => {
	const fake = await openTodo('broken\n');
	using view = render(RowView, { rowEditor: fake.editor, shared: true });
	const source = view.get('textarea');
	expect(source.value).toBe('broken\n');

	type(source, 'still broken\n');
	flushSync();
	expect(fake.editor.get().row).toMatchObject({ text: 'still broken\n' });
	await settle();
	expect(fake.writes).toEqual(['still broken\n']);

	// An outside change reaches the component's field only through Reload.
	fake.writeElsewhere('outside\n');
	await settle();
	flushSync();
	expect(source.value).toBe('still broken\n');
	click(view.target, 'Reload');
	await settle();
	flushSync();
	expect(source.value).toBe('outside\n');
});

test('a failure shows until typing saves; a failed Reload keeps the view and input; Retry saves the text again; a successful Reload discards a failure', async () => {
	const fake = await openTodo('broken\n');
	const { editor } = fake;
	using view = render(RowView, { rowEditor: editor });
	const source = view.get('textarea');
	fake.script('io');
	type(source, 'B\n');
	await settle();
	flushSync();
	expect(view.text('[data-view="save-failure"]')).toBe('Io');

	// Typing after the failure saves at once; its success clears the failure.
	type(source, 'C\n');
	await settle();
	flushSync();
	expect(fake.writes).toEqual(['C\n']);
	expect(view.has('[data-view="save-failure"]')).toBe(false);

	fake.script('io');
	type(source, 'D\n');
	await settle();
	flushSync();
	expect(view.text('[data-view="save-failure"]')).toBe('Io');
	fake.failReads(READ_FAILURE);
	fake.writeElsewhere('X\n');
	click(view.target, 'Reload');
	await settle();
	flushSync();
	expect(view.text('[data-view="reload-failure"]')).toBe('Io');
	expect(view.get('textarea')).toBe(source);
	expect(source.value).toBe('D\n');
	expect(view.text('[data-view="save-failure"]')).toBe('Io');

	click(view.target, 'Retry');
	await settle();
	flushSync();
	expect(fake.writes).toEqual(['C\n', 'D\n']);
	expect(view.has('[data-view="save-failure"]')).toBe(false);

	fake.script('io');
	type(source, 'E\n');
	await settle();
	flushSync();
	expect(view.text('[data-view="save-failure"]')).toBe('Io');
	fake.failReads(undefined);
	fake.writeElsewhere('F\n');
	click(view.target, 'Reload');
	await settle();
	flushSync();
	expect(view.has('[data-view="reload-failure"]')).toBe(false);
	expect(view.has('[data-view="save-failure"]')).toBe(false);
	expect(source.value).toBe('F\n');
	expect(fake.writes).toEqual(['C\n', 'D\n']);
});

/**
 * Invalid raw text, then Reload adopts valid text another writer saved, which
 * removes the raw view while its outro keeps the textarea in the document.
 * Input is then dispatched on the leaving textarea. Svelte marks the leaving
 * section `inert`, which jsdom ignores, so this shows what a delivered event
 * does, not that a person can type there.
 */
async function inputDuringOutro(guarded: boolean) {
	const fake = await openTodo('broken\n');
	const view = render(RowView, {
		rowEditor: fake.editor,
		outro: 1000,
		guarded,
	});
	const source = view.get('textarea');
	fake.writeElsewhere(todo('Fixed'));
	click(view.target, 'Reload');
	await settle();
	flushSync();
	expect(source.isConnected).toBe(true);
	expect(source.closest('section')?.inert).toBe(true);
	expect(view.has('input[aria-label="Title"]')).toBe(true);
	const before = fake.disk();
	type(source, 'x');
	flushSync();
	await settle();
	flushSync();
	return { ...fake, view, source, before };
}

test('a raw view leaving after Reload adopted valid text admits no input', async () => {
	const { editor, view, source, writes, before } = await inputDuringOutro(true);
	using _ = view;
	expect(writes).toEqual([]);
	expect(editor.get().save.status).toBe('idle');
	// The fields view stays chosen: the input did not select raw mode.
	expect(view.has('input[aria-label="Title"]')).toBe(true);

	finishAnimations();
	flushSync();
	expect(source.isConnected).toBe(false);
	expect(editor.get().row).toMatchObject({ text: before });
});

test('without the view gate, a raw view leaving after Reload replaces the whole row', async () => {
	const { view, writes, disk } = await inputDuringOutro(false);
	using _ = view;
	finishAnimations();
	expect(writes).toEqual(['x']);
	expect(disk()).toBe('x');
});

test('textareas show LF and write back the file’s CRLF line endings, trailing ones included', async () => {
	const raw = await openTodo('no frontmatter\r\nsecond\r\n');
	using rawView = render(RowView, { rowEditor: raw.editor });
	const source = rawView.get('textarea');
	// The DOM reports LF. A getter returning the file's CRLF would differ from
	// it after every keystroke and snapshot, and Svelte would assign the field.
	expect(source.value).toBe('no frontmatter\nsecond\n');
	const assigned = countValueAssignments(source);
	type(source, 'no frontmatter\nsecond edited\n\n');
	flushSync();
	await settle();
	flushSync();
	expect(raw.writes).toEqual(['no frontmatter\r\nsecond edited\r\n\r\n']);
	expect(source.value).toBe('no frontmatter\nsecond edited\n\n');
	// Only the keystroke itself set the value.
	expect(assigned()).toBe(1);

	// A structured body keeps its CRLF; the canonical header stays LF.
	const valid = await openTodo(todo('Plan', 'Line 1.\r\nLine 2.\r\n'));
	using validView = render(RowView, { rowEditor: valid.editor });
	const body = validView.get('textarea[aria-label="Body"]');
	expect(body.value).toBe('Line 1.\nLine 2.\n');
	type(body, 'Line 1.\nLine 2 edited.\n');
	flushSync();
	await settle();
	expect(valid.writes).toEqual([todo('Plan', 'Line 1.\r\nLine 2 edited.\r\n')]);
});

test('switching the view to owner B ends the subscription to A while A’s admitted write completes', async () => {
	const a = await openTodo('broken A\n');
	const b = await openTodo('broken B\n');
	const owner = switchable(a.editor);
	a.holdReplies();
	using view = render(RowView, {
		get rowEditor() {
			return owner.current;
		},
	});
	await settle();
	type(view.get('textarea'), 'A2\n');
	flushSync();
	await settle();
	expect(a.heldReplies()).toBe(1);
	expect([a.subscriptions(), b.subscriptions()]).toEqual([1, 0]);

	owner.current = b.editor;
	flushSync();
	await settle();
	flushSync();
	expect([a.subscriptions(), b.subscriptions()]).toEqual([0, 1]);
	expect(view.get('textarea').value).toBe('broken B\n');
	expect(a.editor.get().save.status).toBe('saving');

	a.releaseReplies();
	await settle();
	flushSync();
	expect(a.writes).toEqual(['A2\n']);
	expect(a.editor.get().save.status).toBe('idle');
	expect(view.get('textarea').value).toBe('broken B\n');

	type(view.get('textarea'), 'B2\n');
	flushSync();
	await settle();
	expect(b.writes).toEqual(['B2\n']);
	expect(a.writes).toEqual(['A2\n']);
});

/** The application's timer, fired by the test instead of by time. */
function controlledTimer() {
	const queued = new Set<() => void>();
	return {
		schedule(submit: () => void) {
			queued.add(submit);
			return () => {
				queued.delete(submit);
			};
		},
		pending: () => queued.size,
		fire() {
			const due = [...queued];
			queued.clear();
			for (const submit of due) submit();
		},
	};
}

test("an application draft timer's next submission saves after a failed one; Reload is explicit", async () => {
	const fake = await openTodo('draft A\n');
	const { editor } = fake;
	const timer = controlledTimer();
	using view = render(DraftHost, {
		rowEditor: editor,
		schedule: timer.schedule,
	});
	expect(view.get('textarea').value).toBe('draft A\n');
	expect(timer.pending()).toBe(0);

	type(view.get('textarea'), 'draft B\n');
	flushSync();
	expect(timer.pending()).toBe(1);

	// The file changes elsewhere; nothing follows it.
	fake.writeElsewhere('disk C\n');
	await settle();
	flushSync();
	expect(editor.get().row.text).toBe('draft A\n');

	// The timer submits B and the save fails.
	fake.script('io');
	timer.fire();
	await settle();
	flushSync();
	expect(view.text('[data-view="save-failure"]')).toBe('Io');

	// The timer submits the newer draft, and the owner saves it.
	type(view.get('textarea'), 'draft B2\n');
	flushSync();
	expect(timer.pending()).toBe(1);
	timer.fire();
	await settle();
	flushSync();
	expect(editor.get().row.text).toBe('draft B2\n');
	expect(fake.writes).toEqual(['draft B2\n']);
	expect(view.has('[data-view="save-failure"]')).toBe(false);

	// A failed Reload keeps the unsubmitted draft; a successful one replaces it.
	type(view.get('textarea'), 'draft D\n');
	flushSync();
	fake.failReads(READ_FAILURE);
	fake.writeElsewhere('disk E\n');
	click(view.target, 'Reload');
	await settle();
	flushSync();
	expect(view.text('[data-view="reload-failure"]')).toBe('Io');
	expect(view.get('textarea').value).toBe('draft D\n');
	expect(timer.pending()).toBe(1);

	fake.failReads(undefined);
	click(view.target, 'Reload');
	await settle();
	flushSync();
	expect(view.has('[data-view="reload-failure"]')).toBe(false);
	expect(view.get('textarea').value).toBe('disk E\n');
	expect(editor.get().row.text).toBe('disk E\n');
	// The discarded draft's scheduled call was cancelled with it.
	expect(timer.pending()).toBe(0);
	expect(fake.writes).toEqual(['draft B2\n']);
});

test('unmounting ends the subscription only: an admitted write completes and a remount shows it without reading', async () => {
	const fake = await openTodo('broken\n');
	const { editor } = fake;
	fake.holdReplies();
	const view = render(RowView, { rowEditor: editor });
	type(view.get('textarea'), 'B\n');
	flushSync();
	view.destroy();
	await settle();
	expect(fake.subscriptions()).toBe(0);
	expect(editor.get().save.status).toBe('saving');

	fake.releaseReplies();
	await settle();
	expect(fake.writes).toEqual(['B\n']);
	expect(editor.get().save.status).toBe('idle');

	using again = render(RowView, { rowEditor: editor });
	expect(fake.subscriptions()).toBe(1);
	await settle();
	flushSync();
	expect(fake.reads()).toBe(1);
	expect(again.get('textarea').value).toBe('B\n');
});

test('set owns a $state draft before it returns; a refusal keeps the draft for correction', async () => {
	const fake = await openTodo(todo('Plan'));
	const { editor } = fake;
	using view = render(DraftForm, { rowEditor: editor });
	const title = view.get<HTMLInputElement>('input');

	type(title, 'Plan \uD800');
	click(view.target, 'Save draft');
	flushSync();
	expect(view.text('[data-view="refusal"]')).toContain('lone surrogate');
	expect(title.value).toBe('Plan \uD800');
	expect(editor.get().row).toMatchObject({ fields: { title: 'Plan' } });
	expect(editor.get().save.status).toBe('idle');

	fake.holdReplies();
	type(title, 'Plan 2');
	click(view.target, 'Save draft');
	flushSync();
	expect(view.has('[data-view="refusal"]')).toBe(false);
	const accepted = editor.get().row;
	const submitted = {
		fields: {
			title: 'Plan 2',
			done: false,
			tags: ['a'],
			meta: { nested: [1] },
		},
		body: 'Body.\n',
	};
	expect(accepted).toMatchObject({ status: 'valid', ...submitted });
	expect(view.text('output')).toBe('Plan 2');

	// Later draft edits, nested ones included, reach nothing held or queued.
	click(view.target, 'Change nested');
	type(title, 'Plan 3');
	flushSync();
	expect(editor.get().row).toBe(accepted);
	expect(view.text('output')).toBe('Plan 2');
	fake.releaseReplies();
	await settle();
	expect(fake.writes).toHaveLength(1);
	expect(fieldsOf(fake.writes[0])).toEqual(submitted);
	expect(editor.get().row).toBe(accepted);
});
