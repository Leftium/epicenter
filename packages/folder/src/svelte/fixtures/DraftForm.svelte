<!--
	An application-owned draft: seeded once from the row, edited in deep
	`$state`, and submitted as the live proxy itself when the person saves.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { fromRowEditor } from '../row-editor.svelte.js';
	import type { TodoEditor } from '../row-storage.test-support.js';

	let { rowEditor }: { rowEditor: TodoEditor } = $props();

	const editor = $derived(fromRowEditor(rowEditor));
	let draft = $state(seed());
	let refusal = $state<string>();

	function seed() {
		const row = untrack(() => editor.row);
		if (row.status !== 'valid') throw new Error('The draft needs a valid row');
		return {
			fields: {
				title: row.fields.title,
				done: row.fields.done,
				tags: ['a'],
				meta: { nested: [1] },
			},
			body: row.body,
		};
	}

	function submit() {
		const { error } = editor.set(draft);
		refusal = error?.message;
	}
</script>

<input aria-label="Draft title" bind:value={draft.fields.title} />
<button onclick={submit}>Save draft</button>
<button
	onclick={() => {
		draft.fields.tags.push('late');
		draft.fields.meta.nested.push(2);
	}}>Change nested</button
>
{#if refusal !== undefined}
	<p data-view="refusal">{refusal}</p>
{/if}
{#if editor.row.status === 'valid'}
	<output>{editor.row.fields.title}</output>
{/if}
