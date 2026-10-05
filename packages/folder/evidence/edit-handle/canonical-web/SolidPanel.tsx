/**
 * Solid caller: `from` adapts the editor's invalidations into an accessor.
 *
 * The editor's `subscribe` calls its listener with no value and makes no
 * initial call, so `from`'s `{ subscribe }` form, which publishes the value it
 * is called with, does not fit. The setter form does: the initial value is
 * `get()`, and each invalidation publishes `get()` again. Solid runs the
 * producer while this component is created and its owner's cleanup
 * unsubscribes when the view unmounts.
 *
 * Handlers read the latest row with `get()`, submit the complete row, and
 * return unless the row still supports their own view. A refused `set`
 * accepts nothing and invalidates nothing, so the handler puts its control
 * back to the accepted value itself.
 */
import {
	createSignal,
	For,
	from,
	Match,
	onCleanup,
	Switch,
} from 'solid-js';
import type { CanonicalDocument } from '../../../src/browser.js';
import { withFileNewlines } from '../../../src/file-browser.js';
import {
	controlsOf,
	lf,
	type Presentation,
	saveLabel,
	sourceIssue,
	type TodoEditor,
	type TodoState,
	type ValidTodo,
	withBody,
	withField,
} from './todo-editor.js';
import { PRIORITIES } from './todos.js';

export function SolidPanel(props: {
	editor: TodoEditor;
	presentation: Presentation;
}) {
	// One editor per mount: read the props once, not reactively.
	const { get, subscribe, set, setText } = props.editor;
	const { presentation } = props;
	const state = from<TodoState>(
		(publish) => subscribe(() => publish(() => get())),
		get(),
	);
	const [raw, setRaw] = createSignal(presentation.raw);
	const [message, setMessage] = createSignal('');
	// Controls detach on unmount, but a retained element can still receive an
	// event; no handler submits after cleanup.
	let mounted = true;
	onCleanup(() => {
		mounted = false;
	});

	/** This view's choice of fields or source; the owner keeps it for the next mount. */
	function showSource(next: boolean) {
		if (!mounted) return;
		presentation.raw = next;
		setRaw(next);
	}

	const row = () => state().row;
	const sourceRow = () => {
		const current = row();
		if (current.status === 'invalid') return current;
		return current.status === 'valid' && raw() ? current : undefined;
	};
	const fieldsRow = () => {
		const current = row();
		return current.status === 'valid' && !raw() ? current : undefined;
	};

	/** Submit a complete row from the latest valid row; on refusal, repaint the control. */
	function submit(
		next: (row: ValidTodo) => CanonicalDocument,
		repaint: (row: ValidTodo) => void,
	) {
		if (!mounted) return;
		const latest = get().row;
		if (latest.status !== 'valid' || raw()) return;
		const { error } = set(next(latest));
		setMessage(error === null ? '' : `Not accepted: ${error.message}`);
		if (error !== null) repaint(latest);
	}

	function onSource(control: HTMLTextAreaElement) {
		if (!mounted) return;
		const latest = get().row;
		if (latest.status === 'valid' && !raw()) return;
		// Typing here keeps the source shown after the row becomes valid.
		showSource(true);
		setText(withFileNewlines(control.value, latest.text));
	}

	return (
		<>
			<Switch>
				<Match when={sourceRow()}>
					{(current) => (
						<>
							<p class="warn">{sourceIssue(current())}</p>
							<label>
								Markdown source
								<textarea
									rows={8}
									class="source"
									value={lf(current().text)}
									onInput={(event) => onSource(event.currentTarget)}
								/>
							</label>
							{current().status === 'valid' && (
								<button type="button" onClick={() => showSource(false)}>
									Edit fields
								</button>
							)}
						</>
					)}
				</Match>
				<Match when={fieldsRow()}>
					{(current) => (
						<>
							<label>
								<input
									type="checkbox"
									checked={controlsOf(current()).done}
									onChange={(event) => {
										const control = event.currentTarget;
										submit(
											(latest) => withField(latest, 'done', control.checked),
											(latest) => {
												control.checked = controlsOf(latest).done;
											},
										);
									}}
								/>{' '}
								Done
							</label>
							<label>
								Title{' '}
								<input
									value={controlsOf(current()).title}
									onInput={(event) => {
										const control = event.currentTarget;
										submit(
											(latest) => withField(latest, 'title', control.value),
											(latest) => {
												control.value = controlsOf(latest).title;
											},
										);
									}}
								/>
							</label>
							<label>
								Priority{' '}
								<select
									value={controlsOf(current()).priority}
									onChange={(event) => {
										const control = event.currentTarget;
										// The empty option omits the key, which deletes the field.
										submit(
											(latest) =>
												withField(latest, 'priority', control.value || undefined),
											(latest) => {
												control.value = controlsOf(latest).priority;
											},
										);
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
									value={controlsOf(current()).body}
									onInput={(event) => {
										const control = event.currentTarget;
										submit(
											(latest) => withBody(latest, control.value),
											(latest) => {
												control.value = controlsOf(latest).body;
											},
										);
									}}
								/>
							</label>
							<button type="button" onClick={() => showSource(true)}>
								Edit the Markdown source
							</button>
						</>
					)}
				</Match>
			</Switch>
			<p class="quiet">{saveLabel(state().save)}</p>
			<p class="message">{message()}</p>
		</>
	);
}
