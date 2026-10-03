<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { conforms, type TodoEditor } from '$lib/todo-editor.svelte.js';

	let { editor, onDiscard }: {
		editor: TodoEditor;
		/** Drop this editor's input without writing; offered only when it is discardable. */
		onDiscard: () => void;
	} = $props();

	const current = $derived(editor.state);
	/**
	 * What the latest read found that this editor did not write. Not shown
	 * while a save runs, when a read may be of the bytes it is sending, nor
	 * for a clean draft's valid read, which the draft follows on its own.
	 */
	const external = $derived.by(() => {
		const found = editor.externalChange;
		// After the person's own delete the row's absence, or presence, is not
		// someone else's change; the delete's own choice below covers it.
		if (found === undefined || editor.isSaving || editor.halt?.operation === 'delete')
			return undefined;
		return current.isDirty || found.kind !== 'present' ? found : undefined;
	});
	/** What happened to the file, in the person's words. */
	const happened = $derived.by(() => {
		switch (external?.kind) {
			case undefined:
				return undefined;
			case 'present':
				return 'This todo was changed elsewhere.';
			case 'missing':
				return 'This todo was removed elsewhere.';
			case 'invalid':
			case 'unsupported':
				return 'This todo was changed elsewhere into text that does not read as a todo.';
			case 'unreadable':
				return `This todo could not be read: ${external.error.message}.`;
		}
	});

	async function saveMine() {
		const problem = await editor.save();
		if (problem) toast.error('Could not save the todo', { description: problem });
	}

	function loadSaved() {
		const problem = editor.adopt();
		if (problem) toast.error('Could not load the saved version', { description: problem });
	}
</script>

<!-- One todo editor's save state. -->
<div class="flex min-h-9 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs">
	{#if editor.isSaving}
		<span class="text-muted-foreground">Saving…</span>
	{:else if editor.halt?.operation === 'delete'}
		<!-- The person's own delete went unanswered, or removed the row under new typing. -->
		<span class="w-full text-destructive" role="alert">
			{editor.halt.message}
			{current.isDirty ? 'Your edits are kept here and' : 'This todo is kept open and'} nothing is saved until you choose.
		</span>
		<Button size="xs" onclick={() => void saveMine()}>
			{current.isDirty ? 'Save mine' : 'Keep this todo'}
		</Button>
		<Button size="xs" variant="outline" onclick={onDiscard}>
			{current.isDirty ? 'Discard mine' : 'Close'}
		</Button>
	{:else if editor.halt?.kind === 'failed'}
		<span class="text-destructive" role="alert">Not saved: {editor.halt.message}</span>
		<Button size="xs" variant="outline" onclick={() => void saveMine()}>Try again</Button>
	{:else if editor.halt?.kind === 'unknown'}
		<span class="text-destructive" role="alert">
			{editor.halt.message}
			{#if editor.halt.operation === 'save' && !current.isDirty}The file now has this text, but that does not confirm the save.{/if}
		</span>
		<Button size="xs" variant="outline" onclick={() => void saveMine()}>Save again</Button>
	{:else if editor.isAwaitingReview}
		<span class="text-destructive">Not saved: waiting for your choice below.</span>
	{:else if current.isDirty && !conforms(current)}
		<span class="text-destructive" role="alert">Not saved: some fields need fixing.</span>
	{:else if current.isDirty}
		<span class="text-muted-foreground">Unsaved typing</span>
	{:else}
		<span class="text-muted-foreground">Saved to <code class="font-mono">{current.path}</code></span>
	{/if}
	{#if editor.isDiscardable && editor.externalChange === undefined && editor.halt?.operation !== 'delete'}
		<Button size="xs" variant="outline" onclick={onDiscard}>Discard mine</Button>
	{/if}
	{#if editor.refusal}
		<span class="text-warning">Change refused: {editor.refusal}</span>
	{/if}
</div>

<!--
	A change made elsewhere. With unsaved input nothing saves until the person
	chooses, so this stays until they do. Without input there is nothing to
	keep, only the file to look at again.
-->
{#if external !== undefined}
	<div class="flex flex-wrap items-center gap-2 border-b bg-warning/10 px-4 py-2 text-xs" role="alert">
		{#if current.isDirty}
			<span class="w-full">{happened} Your edits are kept here and are not saved until you choose.</span>
			<Button size="xs" onclick={() => void saveMine()}>
				{external.kind === 'missing' ? 'Save mine again' : 'Save mine over it'}
			</Button>
			{#if external.kind === 'present'}
				<Button size="xs" variant="outline" onclick={loadSaved}>Discard mine and load saved</Button>
			{:else if external.kind === 'invalid' || external.kind === 'unsupported'}
				<Button size="xs" variant="outline" onclick={onDiscard}>Discard mine and open its text</Button>
			{:else}
				<Button size="xs" variant="outline" onclick={onDiscard}>Discard mine</Button>
			{/if}
		{:else}
			<span>{happened}</span>
			{#if external.kind === 'invalid' || external.kind === 'unsupported'}
				<Button size="xs" variant="outline" onclick={onDiscard}>Open its text</Button>
			{:else if external.kind === 'missing'}
				<Button size="xs" variant="outline" onclick={onDiscard}>Close</Button>
			{/if}
		{/if}
		{#if external.kind === 'unreadable'}
			<Button size="xs" variant="ghost" onclick={() => void editor.refresh()}>Check again</Button>
		{/if}
	</div>
{/if}
