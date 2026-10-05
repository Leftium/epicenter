<!--
	The row editing view the package README documents: tracked row and save
	reads, function bindings whose getters narrow the row and whose setters
	return unless the row still supports their view, textarea newlines kept
	in the file's convention, raw repair for invalid input, and explicit
	Retry and Reload. `outro` keeps a leaving raw view in the document;
	`guarded: false` drops the setters' view gates.
-->
<script lang="ts">
	import { withFileNewlines } from '../../file-browser.js';
	import { fromRowEditor } from '../row-editor.svelte.js';
	import type { TodoEditor } from '../row-storage.test-support.js';
	import RawEditor from './RawEditor.svelte';

	let {
		rowEditor,
		shared = false,
		outro = 0,
		guarded = true,
	}: {
		rowEditor: TodoEditor;
		shared?: boolean;
		outro?: number;
		guarded?: boolean;
	} = $props();

	const editor = $derived(fromRowEditor(rowEditor));
	let rawMode = $state(false);
	let refusal = $state<string>();
	let reloadFailure = $state<string>();

	/** Textareas report LF, so show LF and write back the file's convention. */
	const lf = (text: string) => text.replace(/\r\n?/g, '\n');

	function title() {
		return editor.row.status === 'valid' ? editor.row.fields.title : '';
	}

	function setTitle(title: string) {
		if (editor.row.status !== 'valid' || (guarded && rawMode)) return;
		const { error } = editor.set({
			fields: { ...editor.row.fields, title },
			body: editor.row.body,
		});
		refusal = error?.message;
	}

	function body() {
		return editor.row.status === 'valid' ? lf(editor.row.body) : '';
	}

	function setBody(body: string) {
		if (editor.row.status !== 'valid' || (guarded && rawMode)) return;
		const { error } = editor.set({
			fields: editor.row.fields,
			body: withFileNewlines(body, editor.row.body),
		});
		refusal = error?.message;
	}

	function text() {
		return lf(editor.row.text);
	}

	function setText(next: string) {
		// Only a raw view that is leaving gets input the row no longer supports.
		if (guarded && editor.row.status === 'valid' && !rawMode) return;
		rawMode = true;
		editor.setText(withFileNewlines(next, editor.row.text));
	}

	async function reload() {
		const { error } = await editor.reload();
		reloadFailure = error?.name;
	}

	function hold(_node: Element, { duration }: { duration: number }) {
		return { duration };
	}
</script>

{#if editor.save.status === 'failed'}
	<p data-view="save-failure">{editor.save.error.name}</p>
	<button onclick={editor.retry}>Retry</button>
{/if}
{#if refusal !== undefined}
	<p data-view="refusal">{refusal}</p>
{/if}
{#if reloadFailure !== undefined}
	<p data-view="reload-failure">{reloadFailure}</p>
{/if}

{#if editor.row.status === 'invalid' || rawMode}
	<section out:hold={{ duration: outro }}>
		{#if editor.row.status === 'invalid'}
			<p data-view="row-failure">{editor.row.error.name}</p>
		{:else}
			<button onclick={() => (rawMode = false)}>Edit fields</button>
		{/if}
		{#if shared}
			<RawEditor bind:value={text, setText} />
		{:else}
			<textarea aria-label="Markdown source" bind:value={text, setText}
			></textarea>
		{/if}
	</section>
{:else}
	<input aria-label="Title" bind:value={title, setTitle} />
	<textarea aria-label="Body" bind:value={body, setBody}></textarea>
{/if}
<button onclick={reload}>Reload</button>
