<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import type { TextFileEditor } from '$lib/editor.svelte.js';

	let { editor, autosavePaused, onDiscardRemoved }: {
		/** A text draft: an ordinary file, or a row file edited as its text. */
		editor: TextFileEditor;
		autosavePaused: boolean;
		onDiscardRemoved: () => void;
	} = $props();

	let showSaved = $state(false);

	async function keepBoth() {
		const { data: copyPath, error: keepError } = await editor.keepBoth();
		if (keepError !== null) toast.error('Could not keep a copy', { description: keepError });
		else toast.success(`Your edits were saved to ${copyPath}`);
	}
</script>

<!--
	One editor's save state. A failed or unknown save stops saving until the person tries again, and a
	conflict holds both versions until the person chooses. A file that holds the same text answers neither.
-->
<div class="flex min-h-9 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs" data-testid="save-status" data-save-state={editor.saveState.kind}>
	{#if editor.saveState.kind === 'saving'}
		<span class="text-muted-foreground">Saving…</span>
	{:else if editor.saveState.kind === 'failed'}
		<span class="text-destructive" role="alert">Not saved: {editor.saveState.message}. Saving has stopped until you try again.</span>
		<Button size="xs" variant="outline" onclick={() => void editor.retry()}>Try again</Button>
	{:else if editor.saveState.kind === 'unconfirmed'}
		<span class="text-destructive" role="alert">
			The last save was not confirmed, so it may or may not be in the file: {editor.saveState.message}. Your edits are kept
			here, and saving has stopped until you try again.
		</span>
		<Button size="xs" variant="outline" onclick={() => void editor.retry()}>Try again</Button>
	{:else if editor.saveState.kind === 'conflict'}
		<span class="text-destructive" role="alert">
			{editor.saveState.current
				? editor.saveState.current.text === editor.buffer
					? 'This file changed after it was read, and now holds exactly your text. Which save put it there is not known.'
					: 'This file changed elsewhere. Your edits are kept here and not saved.'
				: 'This file was removed elsewhere. Your edits are kept here and not saved.'}
		</span>
		{#if editor.saveState.current}
			<Button size="xs" variant="outline" onclick={() => (showSaved = !showSaved)}>
				{showSaved ? 'Hide saved version' : 'Show saved version'}
			</Button>
			<Button size="xs" variant="outline" onclick={() => editor.loadSaved()}>
				Discard mine and load saved
			</Button>
			<Button size="xs" variant="outline" onclick={() => void keepBoth()}>
				Keep both
			</Button>
			<Button size="xs" onclick={() => void editor.keepMine()}>Save mine over it</Button>
		{:else}
			<Button size="xs" variant="outline" onclick={() => void keepBoth()}>Save mine as a copy</Button>
			<Button size="xs" variant="outline" onclick={onDiscardRemoved}>Discard mine</Button>
		{/if}
	{:else if editor.dirty}
		<span class="text-muted-foreground">{autosavePaused ? 'Unsaved typing (autosave is paused)' : 'Unsaved typing'}</span>
		{#if autosavePaused}
			<Button size="xs" variant="outline" onclick={() => void editor.save()}>Save now</Button>
		{/if}
	{:else if editor.unknown}
		<span class="text-muted-foreground" role="status">
			Showing <code class="font-mono">{editor.path}</code> as it is now. Whether an earlier save reached it is not known.
		</span>
	{:else}
		<span class="text-muted-foreground">Saved to <code class="font-mono">{editor.path}</code></span>
	{/if}
</div>
{#if editor.saveState.kind === 'conflict' && editor.saveState.current && showSaved}
	<div class="border-b bg-muted/40 px-4 py-2" data-testid="conflict-saved-version">
		<p class="mb-1 text-xs font-medium">Saved version in the folder now</p>
		<pre class="max-h-48 overflow-auto rounded border bg-background p-2 font-mono text-xs whitespace-pre-wrap">{editor.saveState.current.text}</pre>
	</div>
{/if}
