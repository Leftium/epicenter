/**
 * Vanilla caller: plain DOM over a shared canonical editor.
 *
 * `subscribe` renders the current state at once and on later notifications;
 * the function it returns stops only this view, never the editor. A refused
 * change emits no state, so the control is repainted from `get()`.
 */
import { h, shortSha } from './dom.js';
import {
	describeChangeError,
	describeSaveError,
	draftOf,
	type TodoEditor,
	type TodoState,
} from './todo-editor.js';
import { PRIORITIES } from './todos.js';

export function mountVanillaPanel(root: HTMLElement, editor: TodoEditor) {
	const { get, subscribe, change, save } = editor;
	const message = h('p', { className: 'message' });

	function apply(requested: Parameters<TodoEditor['change']>[0]) {
		const { error } = change(requested);
		message.textContent = error === null ? '' : describeChangeError(error);
		if (error !== null) render(get());
	}

	const done = h('input', {
		type: 'checkbox',
		onchange: () => apply({ fields: { done: done.checked } }),
	});
	const title = h('input', {
		oninput: () => apply({ fields: { title: title.value } }),
	});
	const priority = h(
		'select',
		{
			// The empty option removes the field from the draft.
			onchange: () =>
				apply({ fields: { priority: priority.value || undefined } }),
		},
		h('option', { value: '' }, '(none: remove the field)'),
		...PRIORITIES.map((option) => h('option', { value: option }, option)),
	);
	const body = h('textarea', {
		rows: 3,
		oninput: () => apply({ body: body.value }),
	});
	const issues = h('ul', { className: 'issues' });
	const status = h('p', { className: 'quiet' });
	const saveButton = h('button', { type: 'button' }, 'Save');
	saveButton.onclick = async () => {
		message.textContent = 'Saving…';
		const { data: receipt, error } = await save();
		message.textContent =
			error !== null
				? describeSaveError(error)
				: `Saved: wrote ${shortSha(receipt.sha256)}`;
	};

	root.replaceChildren(
		h('label', {}, done, ' Done'),
		h('label', {}, 'Title ', title),
		h('label', {}, 'Priority ', priority),
		h('label', {}, 'Body', body),
		issues,
		h('div', { className: 'row' }, saveButton, status),
		message,
	);

	function render(state: TodoState) {
		const draft = draftOf(state);
		// Assign only what changed, so the control being typed in keeps its caret.
		done.checked = draft.done;
		if (title.value !== draft.title) title.value = draft.title;
		if (priority.value !== draft.priority) priority.value = draft.priority;
		if (body.value !== draft.body) body.value = draft.body;
		issues.replaceChildren(
			...state.reading.issues.map((issue) =>
				h('li', {}, `${issue.field}: ${issue.message}`),
			),
		);
		status.textContent = [
			state.isDirty ? 'Unsaved changes' : 'No unsaved changes',
			state.saving !== undefined && 'saving',
		]
			.filter(Boolean)
			.join(', ');
	}

	const unsubscribe = subscribe(render);
	return () => {
		unsubscribe();
		root.replaceChildren();
	};
}
