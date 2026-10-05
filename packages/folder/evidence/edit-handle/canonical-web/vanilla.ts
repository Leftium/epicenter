/**
 * Vanilla caller: plain DOM over a shared row editor.
 *
 * `subscribe` makes no initial call, so the view renders `get()` itself once
 * it has subscribed, then again on every invalidation. The function it
 * returns ends only this view's subscription, never the editor or its saves.
 *
 * Each handler reads the latest row with `get()` and submits the complete
 * row. It returns unless this view is still mounted and the row still
 * supports its own part of it: structured controls only while the row is
 * valid and shown as fields, the source only while it is shown.
 * `presentation` is this view's own choice of fields or source, kept by the
 * owner for the next mount and read by no other view.
 */
import type { CanonicalDocument } from '../../../src/browser.js';
import { withFileNewlines } from '../../../src/file-browser.js';
import { h } from './dom.js';
import {
	controlsOf,
	lf,
	type Presentation,
	saveLabel,
	sourceIssue,
	type TodoEditor,
	type ValidTodo,
	withBody,
	withField,
} from './todo-editor.js';
import { PRIORITIES } from './todos.js';

export function mountVanillaPanel(
	root: HTMLElement,
	editor: TodoEditor,
	presentation: Presentation,
) {
	const { get, subscribe, set, setText } = editor;
	const message = h('p', { className: 'message' });
	/**
	 * Whether this view is mounted. Its controls are detached when it
	 * unmounts, but a retained element can still receive an event, from
	 * script or assistive technology; no handler submits after that.
	 */
	let mounted = true;

	/** Submit a complete row built from the latest valid row, only while the fields are shown. */
	function submit(next: (row: ValidTodo) => CanonicalDocument) {
		if (!mounted) return;
		const { row } = get();
		if (row.status !== 'valid' || presentation.raw) return;
		const { error } = set(next(row));
		message.textContent =
			error === null ? '' : `Not accepted: ${error.message}`;
		// Nothing was accepted, so nothing invalidates: show the accepted row again.
		if (error !== null) render();
	}

	const done = h('input', {
		type: 'checkbox',
		onchange: () => submit((row) => withField(row, 'done', done.checked)),
	});
	const title = h('input', {
		oninput: () => submit((row) => withField(row, 'title', title.value)),
	});
	const priority = h(
		'select',
		{
			// The empty option omits the key, which deletes the field.
			onchange: () =>
				submit((row) =>
					withField(row, 'priority', priority.value || undefined),
				),
		},
		h('option', { value: '' }, '(none: remove the field)'),
		...PRIORITIES.map((option) => h('option', { value: option }, option)),
	);
	const body = h('textarea', {
		rows: 3,
		oninput: () => submit((row) => withBody(row, body.value)),
	});
	const source = h('textarea', {
		rows: 8,
		className: 'source',
		oninput: () => {
			if (!mounted) return;
			const { row } = get();
			if (row.status === 'valid' && !presentation.raw) return;
			// Typing here keeps the source shown after the row becomes valid.
			presentation.raw = true;
			setText(withFileNewlines(source.value, row.text));
		},
	});

	function showSource(raw: boolean) {
		if (!mounted) return;
		presentation.raw = raw;
		render();
	}
	const toSource = h('button', { type: 'button' }, 'Edit the Markdown source');
	toSource.onclick = () => showSource(true);
	const toFields = h('button', { type: 'button' }, 'Edit fields');
	toFields.onclick = () => showSource(false);

	const rowIssue = h('p', { className: 'warn' });
	const fieldsView = h(
		'div',
		{},
		h('label', {}, done, ' Done'),
		h('label', {}, 'Title ', title),
		h('label', {}, 'Priority ', priority),
		h('label', {}, 'Body', body),
		toSource,
	);
	const sourceView = h(
		'div',
		{},
		rowIssue,
		h('label', {}, 'Markdown source', source),
		toFields,
	);
	const saveLine = h('p', { className: 'quiet' });

	root.replaceChildren(fieldsView, sourceView, saveLine, message);

	function render() {
		const { row, save } = get();
		saveLine.textContent = saveLabel(save);
		const shown =
			row.status === 'invalid' || presentation.raw ? sourceView : fieldsView;
		for (const view of [fieldsView, sourceView]) view.hidden = view !== shown;
		// Assign only what changed, so the control being typed in keeps its caret.
		if (shown === sourceView) {
			rowIssue.textContent = sourceIssue(row);
			toFields.hidden = row.status !== 'valid';
			const text = lf(row.text);
			if (source.value !== text) source.value = text;
			return;
		}
		if (row.status !== 'valid') return;
		const values = controlsOf(row);
		done.checked = values.done;
		if (title.value !== values.title) title.value = values.title;
		if (priority.value !== values.priority) priority.value = values.priority;
		if (body.value !== values.body) body.value = values.body;
	}

	const stop = subscribe(render);
	render();
	return () => {
		mounted = false;
		stop();
		root.replaceChildren();
	};
}
