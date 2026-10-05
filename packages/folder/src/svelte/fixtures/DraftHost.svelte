<!--
	An application raw draft. It is seeded once, and an `$effect` submits a
	changed draft through the application's timer. After a failed save, the
	next submission saves again; Retry saves the current text again. Reload
	discards the draft for the file's text when the read succeeds, and keeps it
	when the read fails.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { withFileNewlines } from '../../file-browser.js';
	import { fromRowEditor } from '../row-editor.svelte.js';
	import type { TodoEditor } from '../row-storage.test-support.js';

	let {
		rowEditor,
		schedule,
	}: {
		rowEditor: TodoEditor;
		/** Call `submit` later; the returned function cancels it. */
		schedule: (submit: () => void) => () => void;
	} = $props();

	const editor = $derived(fromRowEditor(rowEditor));
	const seed = untrack(() => editor.row.text);
	let draft = $state(seed);
	let submitted = $state(seed);
	let reloadFailure = $state<string>();

	function submit() {
		submitted = draft;
		editor.setText(withFileNewlines(draft, seed));
	}

	async function reload() {
		const { error } = await editor.reload();
		reloadFailure = error?.name;
		if (error === null) draft = submitted = editor.row.text;
	}

	$effect(() => {
		if (draft === submitted) return;
		return schedule(submit);
	});
</script>

{#if editor.save.status === 'failed'}
	<p data-view="save-failure">{editor.save.error.name}</p>
	<button onclick={editor.retry}>Retry</button>
{/if}
{#if reloadFailure !== undefined}
	<p data-view="reload-failure">{reloadFailure}</p>
{/if}
<textarea aria-label="Draft" bind:value={draft}></textarea>
<button onclick={reload}>Reload</button>
