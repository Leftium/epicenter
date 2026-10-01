<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { toast } from '@epicenter/ui/sonner';
	import { diffLines } from '$lib/line-diff.js';
	import type { FileEditor } from '$lib/notes.svelte.js';

	let {
		editor,
		onSaveAsNote,
		onDiscard,
	}: {
		editor: FileEditor;
		/** Write a draft whose file is gone back into the folder; absent for raw files. */
		onSaveAsNote?: () => Promise<string | undefined>;
		/** Forget a draft whose file is gone or unreadable. */
		onDiscard: () => void;
	} = $props();

	let comparing = $state(false);
	const external = $derived(editor.external);
	const diff = $derived(
		comparing && external?.kind === 'changed'
			? diffLines(external.current.source, editor.buffer)
			: [],
	);

	async function copyDraft() {
		try {
			await navigator.clipboard.writeText(editor.buffer);
			toast.success('Copied the draft');
		} catch {
			toast.error('Could not copy the draft', {
				description: 'Select the text in the Source view and copy it from there.',
			});
		}
	}

	async function saveAsNote() {
		const problem = await onSaveAsNote?.();
		if (problem) toast.error('Could not save the draft', { description: problem });
	}
</script>

<!-- One draft's state: saved, typing, saving, failed, or waiting on a choice. -->
<div class="flex min-h-9 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs" data-testid="draft-status" data-phase={editor.phase}>
	{#if editor.phase === 'saving'}
		<span class="text-muted-foreground">Saving…</span>
		{#if editor.inFlight && editor.buffer !== editor.inFlight.source}
			<span class="text-muted-foreground">Newer typing will be saved next.</span>
		{/if}
	{:else if external?.kind === 'changed'}
		<span class="text-destructive" role="alert">
			This file changed on disk while you were editing. Your draft is kept here and is not saved.
		</span>
		<Button size="xs" variant="outline" onclick={() => (comparing = true)}>Compare</Button>
		<Button size="xs" variant="outline" onclick={() => editor.loadSaved()}>Discard my draft and load the file</Button>
		<Button size="xs" onclick={() => void editor.saveMine()}>Save my draft over the file</Button>
	{:else if external?.kind === 'removed'}
		<span class="text-destructive" role="alert">
			This file was deleted on disk. Your draft is kept here and is not saved.
		</span>
		<Button size="xs" variant="outline" onclick={copyDraft}>Copy draft</Button>
		{#if onSaveAsNote}<Button size="xs" onclick={saveAsNote}>Save draft as a note</Button>{/if}
		<Button size="xs" variant="ghost-destructive" onclick={onDiscard}>Discard draft</Button>
	{:else if external?.kind === 'unreadable'}
		<span class="text-destructive" role="alert">
			This file can no longer be read as text ({external.message}). Your draft is kept here.
		</span>
		<Button size="xs" variant="outline" onclick={copyDraft}>Copy draft</Button>
		{#if onSaveAsNote}<Button size="xs" onclick={saveAsNote}>Save draft as a new note</Button>{/if}
		<Button size="xs" variant="ghost-destructive" onclick={onDiscard}>Discard draft</Button>
	{:else if editor.phase === 'failed'}
		<span class="text-destructive" role="alert">Not saved: {editor.failure}. Your draft is kept.</span>
		<Button size="xs" variant="outline" onclick={() => void editor.retry()}>Try again</Button>
		<Button size="xs" variant="ghost" onclick={copyDraft}>Copy draft</Button>
	{:else if editor.dirty}
		<span class="text-muted-foreground">Draft: unsaved typing</span>
	{:else}
		<span class="text-muted-foreground">Saved to <code class="font-mono">{editor.path}</code></span>
	{/if}
	{#if editor.refusal}
		<span class="text-warning" role="status">Change refused: {editor.refusal}</span>
	{/if}
</div>

<Dialog.Root bind:open={comparing}>
	<Dialog.Content class="flex max-h-[85vh] flex-col sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title>Compare the file with your draft</Dialog.Title>
			<Dialog.Description>
				Red lines are only in the file on disk. Green lines are only in your draft.
			</Dialog.Description>
		</Dialog.Header>
		<pre class="min-h-0 flex-1 overflow-auto rounded border bg-muted/30 p-2 font-mono text-xs" data-testid="compare">{#each diff as line, index (index)}<span
					class={line.kind === 'removed'
						? 'block bg-destructive/15 text-destructive'
						: line.kind === 'added'
							? 'block bg-success/15 text-success'
							: 'block text-muted-foreground'}>{line.kind === 'removed' ? '- ' : line.kind === 'added' ? '+ ' : '  '}{line.text}</span>{/each}</pre>
		<Dialog.Footer>
			<Button
				variant="outline"
				onclick={() => {
					comparing = false;
					editor.loadSaved();
				}}
			>
				Discard my draft and load the file
			</Button>
			<Button
				onclick={() => {
					comparing = false;
					void editor.saveMine();
				}}
			>
				Save my draft over the file
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
