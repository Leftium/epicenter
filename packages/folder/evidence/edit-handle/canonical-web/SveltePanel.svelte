<!--
	Svelte caller, runes only: `createSubscriber` subscribes to the editor
	while the template reads `current`, and unsubscribes when no effect reads
	it, including when this component is destroyed. `read` changes only when
	the `editor` prop is a different editor; `current` changes with each
	notification. Each subscription and its `get` use the same editor.

	A refused change emits no state, so `current` does not update; the
	handler puts its control back to the editor's current value itself.
-->
<script lang="ts">
	import { createSubscriber } from 'svelte/reactivity';
		import { shortSha } from './dom.js';
	import {
		describeChangeError,
		describeSaveError,
		draftOf,
		type TodoEditor,
	} from './todo-editor.js';
	import { PRIORITIES } from './todos.js';

	let { editor }: { editor: TodoEditor } = $props();
	let message = $state('');

	const read = $derived.by(() => {
		const { get, subscribe } = editor;
		const track = createSubscriber((update) => subscribe(update));
		return () => {
			track();
			return get();
		};
	});
	const current = $derived(read());
	const draft = $derived(draftOf(current));
	const { get, change, save } = $derived(editor);

	/** Apply a change; on refusal, repaint the control from the editor. */
	function apply(requested: Parameters<TodoEditor['change']>[0], repaint: () => void) {
		const { error } = change(requested);
		message = error === null ? '' : describeChangeError(error);
		if (error !== null) repaint();
	}

	async function onSave() {
		message = 'Saving…';
		const { data: receipt, error } = await save();
		message =
			error !== null
				? describeSaveError(error)
				: `Saved: wrote ${shortSha(receipt.sha256)}`;
	}
</script>

<label>
	<input
		type="checkbox"
		checked={draft.done}
		onchange={(event) => {
			const control = event.currentTarget;
			apply({ fields: { done: control.checked } }, () => {
				control.checked = draftOf(get()).done;
			});
		}}
	/>
	Done
</label>
<label>
	Title
	<input
		value={draft.title}
		oninput={(event) => {
			const control = event.currentTarget;
			apply({ fields: { title: control.value } }, () => {
				control.value = draftOf(get()).title;
			});
		}}
	/>
</label>
<label>
	Priority
	<select
		value={draft.priority}
		onchange={(event) => {
			const control = event.currentTarget;
			apply({ fields: { priority: control.value || undefined } }, () => {
				control.value = draftOf(get()).priority;
			});
		}}
	>
		<option value="">(none: remove the field)</option>
		{#each PRIORITIES as option (option)}
			<option value={option}>{option}</option>
		{/each}
	</select>
</label>
<label>
	Body
	<textarea
		rows="3"
		value={draft.body}
		oninput={(event) => {
			const control = event.currentTarget;
			apply({ body: control.value }, () => {
				control.value = draftOf(get()).body;
			});
		}}
	></textarea>
</label>
<ul class="issues">
	{#each current.reading.issues as issue, index (index)}
		<li>{issue.field}: {issue.message}</li>
	{/each}
</ul>
<div class="row">
	<button type="button" onclick={() => void onSave()}>Save</button>
	<p class="quiet">
		{current.isDirty ? 'Unsaved changes' : 'No unsaved changes'}{current.saving
			? ', saving'
			: ''}
	</p>
</div>
<p class="message">{message}</p>
