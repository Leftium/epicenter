/**
 * Solid caller: `from(edit, edit.get())` turns the shared handle into an
 * accessor, and the owner's cleanup unsubscribes when this view unmounts.
 * No other binding code.
 *
 * A refused change emits no state, so the accessor does not rerun; the
 * handler puts its control back to the handle's current value itself.
 */
import { createSignal, For, from } from 'solid-js';
import { PRIORITIES } from '../todos.js';
import { describeRefusal, type Priority, type TodoEdit } from './todo-edits.js';

export function SolidPanel(props: { edit: TodoEdit }) {
	// One handle per mount: read the prop once, not reactively.
	const edit = props.edit;
	const state = from(edit, edit.get());
	const fields = () => state().reading.fields;
	const unparsed = () => state().reading.parseError !== undefined;
	const [refusal, setRefusal] = createSignal('');
	/** Report a change; on refusal, repaint the control from the handle. */
	const report = (
		result: ReturnType<TodoEdit['change']>,
		repaint: () => void,
	) => {
		setRefusal(result.error ? describeRefusal(result.error) : '');
		if (result.error) repaint();
	};

	return (
		<>
			<label>
				<input
					type="checkbox"
					checked={fields().done === true}
					disabled={unparsed()}
					onChange={(event) => {
						const control = event.currentTarget;
						report(edit.change({ fields: { done: control.checked } }), () => {
							control.checked = edit.get().reading.fields.done === true;
						});
					}}
				/>{' '}
				Done
			</label>
			<label>
				Title{' '}
				<input
					value={fields().title ?? ''}
					disabled={unparsed()}
					onInput={(event) => {
						const control = event.currentTarget;
						report(edit.change({ fields: { title: control.value } }), () => {
							control.value = edit.get().reading.fields.title ?? '';
						});
					}}
				/>
			</label>
			<label>
				Priority{' '}
				<select
					value={fields().priority ?? ''}
					disabled={unparsed()}
					onChange={(event) => {
						const control = event.currentTarget;
						report(
							edit.change({ fields: { priority: control.value as Priority } }),
							() => {
								control.value = edit.get().reading.fields.priority ?? '';
							},
						);
					}}
				>
					<For each={PRIORITIES}>
						{(option) => <option value={option}>{option}</option>}
					</For>
				</select>
			</label>
			<label>
				Body
				<textarea
					rows={3}
					value={state().reading.body ?? ''}
					disabled={unparsed()}
					onInput={(event) => {
						const control = event.currentTarget;
						report(edit.change({ body: control.value }), () => {
							control.value = edit.get().reading.body ?? '';
						});
					}}
				/>
			</label>
			<label>
				Raw source
				<textarea
					rows={8}
					class="source"
					value={state().source}
					onInput={(event) => edit.input(event.currentTarget.value)}
				/>
			</label>
			<ul class="diagnostics">
				<For each={state().reading.parseError?.diagnostics ?? []}>
					{(diagnostic) => <li>Does not parse: {diagnostic.message}</li>}
				</For>
				<For each={state().reading.issues}>
					{(issue) => (
						<li>
							{issue.field}: {issue.message}
						</li>
					)}
				</For>
			</ul>
			<p class="refusal">{refusal()}</p>
		</>
	);
}
