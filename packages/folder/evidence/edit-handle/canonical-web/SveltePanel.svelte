<!--
	Svelte caller, through the package's adapter: `fromRowEditor` from
	`@epicenter/folder/svelte`. `editor.row` and `editor.save` return the
	owner's current `get()` parts and, read in the template, subscribe through
	one `createSubscriber`; the subscription ends when this component is
	destroyed. Nothing is copied into local state.

	Function bindings: each getter narrows the row, and each setter reads the
	latest row, submits the complete row, and returns unless the row still
	supports its own view. A leaving view can still receive input, and an
	unguarded setter would then replace the whole row. `unmount` removes the
	view from the document, but Svelte never removes the listeners its
	bindings add to an element, so a retained control can still call a setter;
	each setter also returns once the view is destroyed. A refused `set`
	accepts nothing, and the binding shows the accepted value again.
-->
<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import type { CanonicalDocument } from '../../../src/browser.js';
	import { withFileNewlines } from '../../../src/file-browser.js';
	import { fromRowEditor } from '../../../src/svelte/row-editor.svelte.js';
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

	let {
		rowEditor,
		presentation,
	}: { rowEditor: TodoEditor; presentation: Presentation } = $props();

	// The caller remounts this panel for each owner.
	const editor = fromRowEditor(untrack(() => rowEditor));
	/** This view's choice of fields or source; the owner keeps it for the next mount. */
	let raw = $state(untrack(() => presentation.raw));
	let message = $state('');
	/** Cleared on destroy: a binding's listener outlives the view on a retained element. */
	let mounted = true;
	onDestroy(() => {
		mounted = false;
	});

	function showSource(next: boolean) {
		raw = next;
		presentation.raw = next;
	}

	/** The latest valid row's controls, or empty ones while the fields are not shown. */
	function controls() {
		const row = editor.row;
		return row.status === 'valid'
			? controlsOf(row)
			: { title: '', done: false, priority: '', body: '' };
	}

	/** Submit a complete row from the latest valid row, only while the fields are shown. */
	function submit(next: (row: ValidTodo) => CanonicalDocument) {
		if (!mounted) return;
		const row = editor.row;
		if (row.status !== 'valid' || raw) return;
		const { error } = editor.set(next(row));
		message = error === null ? '' : `Not accepted: ${error.message}`;
	}

	function source() {
		return lf(editor.row.text);
	}

	function setSource(value: string) {
		if (!mounted) return;
		const row = editor.row;
		if (row.status === 'valid' && !raw) return;
		// Typing here keeps the source shown after the row becomes valid.
		showSource(true);
		editor.setText(withFileNewlines(value, row.text));
	}
</script>

{#if editor.row.status === 'invalid' || raw}
	<p class="warn">{sourceIssue(editor.row)}</p>
	<label>
		Markdown source
		<textarea rows="8" class="source" bind:value={source, setSource}></textarea>
	</label>
	{#if editor.row.status === 'valid'}
		<button type="button" onclick={() => showSource(false)}>Edit fields</button>
	{/if}
{:else}
	<label>
		<input type="checkbox" bind:checked={() => controls().done, (value: boolean) => submit((row) => withField(row, 'done', value))} />
		Done
	</label>
	<label>
		Title
		<input bind:value={() => controls().title, (value: string) => submit((row) => withField(row, 'title', value))} />
	</label>
	<label>
		Priority
		<!-- The empty option omits the key, which deletes the field. -->
		<select bind:value={() => controls().priority, (value: string) => submit((row) => withField(row, 'priority', value || undefined))}>
			<option value="">(none: remove the field)</option>
			{#each PRIORITIES as option (option)}
				<option value={option}>{option}</option>
			{/each}
		</select>
	</label>
	<label>
		Body
		<textarea rows="3" bind:value={() => controls().body, (value: string) => submit((row) => withBody(row, value))}></textarea>
	</label>
	<button type="button" onclick={() => showSource(true)}>
		Edit the Markdown source
	</button>
{/if}
<p class="quiet">{saveLabel(editor.save)}</p>
<p class="message">{message}</p>
