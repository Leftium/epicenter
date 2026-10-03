/**
 * Vanilla caller: plain DOM over a shared edit handle.
 *
 * `edit.subscribe` renders every state; each control calls `edit.change` or
 * `edit.input`. A refused change leaves the state as it was, so no state
 * arrives; the control is repainted from `edit.get()` instead. Nothing here
 * saves: saving is a separate decision.
 */
import { PRIORITIES } from '../todos.js';
import { h } from './dom.js';
import {
	describeRefusal,
	type Priority,
	type TodoEdit,
	type TodoState,
} from './todo-edits.js';

export function mountVanillaPanel(root: HTMLElement, edit: TodoEdit) {
	const refusal = h('p', { className: 'refusal' });
	const report = (result: ReturnType<TodoEdit['change']>) => {
		refusal.textContent = result.error ? describeRefusal(result.error) : '';
		if (result.error) render(edit.get());
	};

	const done = h('input', {
		type: 'checkbox',
		onchange: () => report(edit.change({ fields: { done: done.checked } })),
	});
	const title = h('input', {
		oninput: () => report(edit.change({ fields: { title: title.value } })),
	});
	const priority = h(
		'select',
		{
			onchange: () =>
				report(
					edit.change({ fields: { priority: priority.value as Priority } }),
				),
		},
		...PRIORITIES.map((option) => h('option', { value: option }, option)),
	);
	const body = h('textarea', {
		rows: 3,
		oninput: () => report(edit.change({ body: body.value })),
	});
	const source = h('textarea', {
		rows: 8,
		className: 'source',
		oninput: () => edit.input(source.value),
	});
	const diagnostics = h('ul', { className: 'diagnostics' });

	root.replaceChildren(
		h('label', {}, done, ' Done'),
		h('label', {}, 'Title ', title),
		h('label', {}, 'Priority ', priority),
		h('label', {}, 'Body', body),
		h('label', {}, 'Raw source', source),
		diagnostics,
		refusal,
	);

	function render(state: TodoState) {
		const { fields, parseError, issues } = state.reading;
		const unparsed = parseError !== undefined;
		// Assign only what changed, so the control being typed in keeps its caret.
		done.checked = fields.done === true;
		if (title.value !== (fields.title ?? '')) title.value = fields.title ?? '';
		if (priority.value !== (fields.priority ?? ''))
			priority.value = fields.priority ?? '';
		if (body.value !== (state.reading.body ?? ''))
			body.value = state.reading.body ?? '';
		if (source.value !== state.source) source.value = state.source;
		for (const control of [done, title, priority, body])
			control.disabled = unparsed;
		diagnostics.replaceChildren(
			...(parseError?.diagnostics ?? []).map((diagnostic) =>
				h('li', {}, `Does not parse: ${diagnostic.message}`),
			),
			...issues.map((issue) => h('li', {}, `${issue.field}: ${issue.message}`)),
		);
	}

	const stop = edit.subscribe(render);
	return () => {
		stop();
		root.replaceChildren();
	};
}
