/**
 * Solid caller: `from` turns the editor's `subscribe` into an accessor, and
 * the owner's cleanup unsubscribes when this view unmounts. The editor
 * itself fits `from`'s producer shape too; `{ subscribe }` shows that a
 * destructured method needs no `this`.
 *
 * A refused change emits no state, so the accessor does not rerun; the
 * handler puts its control back to the editor's current value itself.
 */
import { createSignal, For, from } from 'solid-js';
import { shortSha } from './dom.js';
import {
	describeChangeError,
	describeSaveError,
	draftOf,
	type TodoEditor,
} from './todo-editor.js';
import { PRIORITIES } from './todos.js';

export function SolidPanel(props: { editor: TodoEditor }) {
	// One editor per mount: read the prop once, not reactively.
	const { get, subscribe, change, save } = props.editor;
	const state = from({ subscribe }, get());
	const draft = () => draftOf(state());
	const [message, setMessage] = createSignal('');

	/** Apply a change; on refusal, repaint the control from the editor. */
	function apply(
		requested: Parameters<TodoEditor['change']>[0],
		repaint: () => void,
	) {
		const { error } = change(requested);
		setMessage(error === null ? '' : describeChangeError(error));
		if (error !== null) repaint();
	}

	async function onSave() {
		setMessage('Saving…');
		const { data: receipt, error } = await save();
		setMessage(
			error !== null
				? describeSaveError(error)
				: `Saved: wrote ${shortSha(receipt.sha256)}`,
		);
	}

	return (
		<>
			<label>
				<input
					type="checkbox"
					checked={draft().done}
					onChange={(event) => {
						const control = event.currentTarget;
						apply({ fields: { done: control.checked } }, () => {
							control.checked = draftOf(get()).done;
						});
					}}
				/>{' '}
				Done
			</label>
			<label>
				Title{' '}
				<input
					value={draft().title}
					onInput={(event) => {
						const control = event.currentTarget;
						apply({ fields: { title: control.value } }, () => {
							control.value = draftOf(get()).title;
						});
					}}
				/>
			</label>
			<label>
				Priority{' '}
				<select
					value={draft().priority}
					onChange={(event) => {
						const control = event.currentTarget;
						apply({ fields: { priority: control.value || undefined } }, () => {
							control.value = draftOf(get()).priority;
						});
					}}
				>
					<option value="">(none: remove the field)</option>
					<For each={PRIORITIES}>
						{(option) => <option value={option}>{option}</option>}
					</For>
				</select>
			</label>
			<label>
				Body
				<textarea
					rows={3}
					value={draft().body}
					onInput={(event) => {
						const control = event.currentTarget;
						apply({ body: control.value }, () => {
							control.value = draftOf(get()).body;
						});
					}}
				/>
			</label>
			<ul class="issues">
				<For each={state().reading.issues}>
					{(issue) => (
						<li>
							{issue.field}: {issue.message}
						</li>
					)}
				</For>
			</ul>
			<div class="row">
				<button type="button" onClick={() => void onSave()}>
					Save
				</button>
				<p class="quiet">
					{state().isDirty ? 'Unsaved changes' : 'No unsaved changes'}
					{state().saving !== undefined ? ', saving' : ''}
				</p>
			</div>
			<p class="message">{message()}</p>
		</>
	);
}
