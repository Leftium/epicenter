<!--
	Svelte caller: `createSubscriber` subscribes to the handle while the
	template reads `current`, and unsubscribes when no effect reads it,
	including when this component is destroyed. `read` changes only when the
	`edit` prop is a different handle; `current` changes with each
	notification. Each subscription and its `get` use the same captured
	handle.

	A refused change emits no state, so `current` does not update; the
	handler puts its control back to the handle's current value itself.
-->
<script lang="ts">
	import { createSubscriber } from 'svelte/reactivity';
	import { PRIORITIES } from '../todos.js';
	import {
		describeRefusal,
		type Priority,
		type TodoEdit,
	} from './todo-edits.js';

	let { edit }: { edit: TodoEdit } = $props();
	let refusal = $state('');

	const read = $derived.by(() => {
		const handle = edit;
		const track = createSubscriber((update) => handle.subscribe(update));
		return () => {
			track();
			return handle.get();
		};
	});
	const current = $derived(read());
	const unparsed = $derived(current.reading.parseError !== undefined);

	/** Report a change; on refusal, repaint the control from the handle. */
	function report(result: ReturnType<TodoEdit['change']>, repaint: () => void) {
		refusal = result.error ? describeRefusal(result.error) : '';
		if (result.error) repaint();
	}
</script>

<label>
	<input
		type="checkbox"
		checked={current.reading.fields.done === true}
		disabled={unparsed}
		onchange={(event) => {
			const control = event.currentTarget;
			report(edit.change({ fields: { done: control.checked } }), () => {
				control.checked = edit.get().reading.fields.done === true;
			});
		}}
	/>
	Done
</label>
<label>
	Title
	<input
		value={current.reading.fields.title ?? ''}
		disabled={unparsed}
		oninput={(event) => {
			const control = event.currentTarget;
			report(edit.change({ fields: { title: control.value } }), () => {
				control.value = edit.get().reading.fields.title ?? '';
			});
		}}
	/>
</label>
<label>
	Priority
	<select
		value={current.reading.fields.priority ?? ''}
		disabled={unparsed}
		onchange={(event) => {
			const control = event.currentTarget;
			report(
				edit.change({ fields: { priority: control.value as Priority } }),
				() => {
					control.value = edit.get().reading.fields.priority ?? '';
				},
			);
		}}
	>
		{#each PRIORITIES as option (option)}
			<option value={option}>{option}</option>
		{/each}
	</select>
</label>
<label>
	Body
	<textarea
		rows="3"
		value={current.reading.body ?? ''}
		disabled={unparsed}
		oninput={(event) => {
			const control = event.currentTarget;
			report(edit.change({ body: control.value }), () => {
				control.value = edit.get().reading.body ?? '';
			});
		}}
	></textarea>
</label>
<label>
	Raw source
	<textarea
		rows="8"
		class="source"
		value={current.source}
		oninput={(event) => edit.input(event.currentTarget.value)}
	></textarea>
</label>
<ul class="diagnostics">
	{#each current.reading.parseError?.diagnostics ?? [] as diagnostic, index (index)}
		<li>Does not parse: {diagnostic.message}</li>
	{/each}
	{#each current.reading.issues as issue, index (index)}
		<li>{issue.field}: {issue.message}</li>
	{/each}
</ul>
<p class="refusal">{refusal}</p>
