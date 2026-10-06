<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import type { TextFileEditor } from '$lib/editor.svelte.js';

	let { editor, onDiscard }: {
		editor: TextFileEditor;
		/** Drop this editor's input without writing; offered only when it cannot save. */
		onDiscard: () => void;
	} = $props();
</script>

<!-- One raw text editor's save state, including the conflict choice that keeps or replaces the input. -->
<div class="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs">
	{#if editor.saveState.kind === 'saving'}
		<span class="text-muted-foreground">Saving…</span>
	{:else if editor.saveState.kind === 'failed'}
		<span class="text-destructive" role="alert">
			Not saved: {editor.saveState.message}. Your typing stays here and is not sent until you try again.
		</span>
		<Button size="xs" variant="outline" onclick={() => void editor.retry()}>Try again</Button>
		<Button size="xs" variant="outline" onclick={onDiscard}>Discard mine</Button>
	{:else if editor.saveState.kind === 'unknown' && editor.saveState.operation === 'delete'}
		<span class="text-destructive" role="alert">
			The delete was sent, but its reply was lost, so this file may or may not still be in the folder.
			{editor.dirty ? 'Your typing stays here and' : 'It is kept open and'} nothing is sent until you choose.
		</span>
		{#if editor.dirty}
			<!-- A conditional save: a file the delete did remove comes back as a conflict. -->
			<Button size="xs" onclick={() => void editor.retry()}>Save mine</Button>
		{/if}
		<Button size="xs" variant="outline" onclick={onDiscard}>{editor.dirty ? 'Discard mine' : 'Close'}</Button>
	{:else if editor.saveState.kind === 'unknown'}
		<span class="text-destructive" role="alert">
			{editor.saveState.message === undefined
				? 'The save was sent, but its reply was lost, so it may or may not be in the file.'
				: `The save ended with an error, so it may or may not be in the file: ${editor.saveState.message}.`}
			Your typing stays here and is not sent until you try again.
		</span>
		<Button size="xs" variant="outline" onclick={() => void editor.retry()}>Try again</Button>
		<Button size="xs" variant="outline" onclick={onDiscard}>Discard mine</Button>
	{:else if editor.saveState.kind === 'conflict'}
		<span class="text-destructive" role="alert">
			{editor.saveState.current
				? 'This file changed elsewhere. Your edits are kept here and not saved.'
				: 'This file was removed elsewhere. Your edits are kept here and not saved.'}
		</span>
		{#if editor.saveState.current}
			<Button size="xs" variant="outline" onclick={() => editor.loadSaved()}>
				Discard mine and load saved
			</Button>
			<Button size="xs" onclick={() => void editor.keepMine()}>Save mine over it</Button>
		{:else}
			<Button size="xs" variant="outline" onclick={onDiscard}>Discard mine</Button>
		{/if}
	{:else if editor.dirty}
		<span class="text-muted-foreground">Unsaved typing</span>
	{:else}
		<span class="text-muted-foreground">Saved to <code class="font-mono">{editor.path}</code></span>
	{/if}
</div>
