/**
 * EXPERIMENT: `edits.files.edit` on a plain text file. The same engine, with
 * no fields to change: only `input`, `save`, and review.
 */
import { NOTES_PATH } from '../todos.js';
import { h, shortSha } from './dom.js';
import type { DemoFolder } from './folder-http.js';
import type { TodoEdits } from './todo-edits.js';

export async function mountNotes(
	root: HTMLElement,
	{ folder, edits }: { folder: DemoFolder; edits: TodoEdits },
) {
	const read = await folder.files.read(NOTES_PATH);
	if (read.error) {
		root.replaceChildren(h('p', { className: 'warn' }, read.error.message));
		return () => {};
	}
	const edit = edits.files.edit({
		path: NOTES_PATH,
		sha256: read.data.sha256,
		text: new TextDecoder().decode(read.data.bytes),
	});
	const text = h('textarea', {
		rows: 3,
		oninput: () => edit.input(text.value),
	});
	const status = h('p', { className: 'quiet' });
	root.replaceChildren(
		text,
		h(
			'div',
			{ className: 'buttons' },
			h('button', { onclick: () => void edit.save() }, 'Save notes.txt'),
			h('button', { onclick: () => edit.discard() }, 'Discard'),
			h('button', { onclick: () => void edit.refresh() }, 'Read file now'),
		),
		status,
	);
	const stop = edit.subscribe((state) => {
		if (text.value !== state.source) text.value = state.source;
		status.textContent = [
			`Baseline ${shortSha(state.baseline.sha256)}`,
			state.isDirty ? 'unsaved changes' : 'saved',
			state.saving ? 'saving' : '',
			state.lastSave ? `last save: ${state.lastSave.kind}` : '',
			state.incoming ? `incoming: ${state.incoming.kind}` : '',
		]
			.filter(Boolean)
			.join(' · ');
	});
	return () => {
		stop();
		void edit.dispose();
	};
}
