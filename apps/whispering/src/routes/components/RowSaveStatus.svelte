<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import type { Library } from '$lib/library.svelte.js';
	import type { RowDraft } from '$lib/row-draft.svelte.js';

	/**
	 * One row draft's save, in the folder editor's terms. A save writes the
	 * whole row, so when the file is not the version the typing was made on,
	 * nothing is saved until the person chooses. A save that failed or was
	 * never answered stops saving until the person saves again, and an unknown
	 * one stays unknown even when the file holds the same text.
	 */
	let { library, draft }: { library: Library; draft: RowDraft<unknown> } = $props();

	const status = $derived(draft.status);
	let showCurrent = $state(false);
	/** The text the file holds now, when it differs from what the typing was made on. */
	const current = $derived(
		status.kind === 'changed' ? status.current.text : status.kind === 'unrecognized' ? status.source : undefined,
	);

	async function keepBoth() {
		const { data: copyPath, error: keepError } = await library.keepDraftCopy(draft.path);
		if (keepError !== null) toast.error('Could not keep a copy', { description: keepError });
		else toast.success(`Your edits were saved to ${copyPath}`);
	}

	async function discard() {
		const problem = await library.discardDraft(draft.path);
		if (problem) toast.error('Your edits were kept', { description: problem });
	}
</script>

<div class="flex min-h-9 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs" data-testid="save-status" data-save-state={status.kind}>
	{#if status.kind === 'saving'}
		<span class="text-muted-foreground">Saving…</span>
	{:else if status.kind === 'failed' || status.kind === 'unconfirmed'}
		{#if status.inFile}
			<span class="text-warning" role="status">
				The file holds this text.
				{status.kind === 'failed'
					? `The last save failed: ${status.message}.`
					: `Whether the last save reached it is not known: ${status.message}.`}
				Saving has stopped until you choose.
			</span>
			<Button size="xs" variant="outline" onclick={() => void discard()}>Take the file as it is</Button>
			<Button size="xs" variant="outline" onclick={() => void draft.saveNow()}>Save again</Button>
		{:else}
			<span class="text-destructive" role="alert">
				{status.kind === 'failed'
					? `Not saved: ${status.message}`
					: `The last save was not confirmed, so it may or may not be in the file: ${status.message}`}
				Saving has stopped until you save again.
			</span>
			<Button size="xs" variant="outline" onclick={() => void draft.saveNow()}>Save again</Button>
			<Button size="xs" variant="outline" onclick={() => void discard()}>Discard mine and take the file</Button>
		{/if}
	{:else if status.kind === 'changed' || status.kind === 'unrecognized'}
		<span class="text-destructive" role="alert">
			{status.kind === 'changed'
				? 'This file changed elsewhere. Your edits are kept here and not saved.'
				: `This file changed elsewhere and no longer reads as this kind of file (${status.message}). Your edits are kept here and not saved.`}
		</span>
		<Button size="xs" variant="outline" onclick={() => (showCurrent = !showCurrent)}>
			{showCurrent ? 'Hide saved version' : 'Show saved version'}
		</Button>
		<Button size="xs" variant="outline" onclick={() => void discard()}>
			{draft.isDirty ? 'Discard mine and load saved' : 'Take the file as it is'}
		</Button>
		<Button size="xs" variant="outline" onclick={() => void keepBoth()}>Keep both</Button>
		<Button size="xs" onclick={() => void draft.saveNow()}>Save mine over it</Button>
	{:else if status.kind === 'removed'}
		<span class="text-destructive" role="alert">This file was removed elsewhere. Your edits are kept here and not saved.</span>
		<Button size="xs" variant="outline" onclick={() => void keepBoth()}>Save mine as a copy</Button>
		<Button size="xs" variant="outline" onclick={() => void discard()}>{draft.isDirty ? 'Discard mine' : 'Close this draft'}</Button>
	{:else if status.kind === 'unreadable'}
		<span class="text-destructive" role="alert">
			This file could not be read: {status.message}. Your edits are kept here and not saved.
		</span>
		<Button size="xs" variant="outline" onclick={() => void draft.refresh()}>Check again</Button>
		<Button size="xs" variant="outline" onclick={() => void keepBoth()}>Save mine as a copy</Button>
	{:else if status.kind === 'invalid'}
		<span class="text-warning" role="status">Not saved until this is fixed: {status.message}</span>
	{:else if status.kind === 'unsaved'}
		<span class="text-muted-foreground">{library.autosave.paused ? 'Unsaved typing (autosave is paused)' : 'Unsaved typing'}</span>
		{#if library.autosave.paused}
			<Button size="xs" variant="outline" onclick={() => void draft.saveNow()}>Save now</Button>
		{/if}
	{:else if draft.unknown}
		<span class="text-muted-foreground" role="status">
			Showing <code class="font-mono">{draft.path}</code> as it is now. Whether an earlier save reached it is not known.
		</span>
	{:else}
		<span class="text-muted-foreground">Saved to <code class="font-mono">{draft.path}</code></span>
	{/if}
	{#if draft.unknown && (status.kind === 'changed' || status.kind === 'unrecognized' || status.kind === 'removed' || status.kind === 'unreadable')}
		<span class="text-warning" role="status">Whether the last save reached the file is not known.</span>
	{/if}
	{#if draft.refusal}
		<span class="text-warning">Change refused: {draft.refusal}</span>
	{/if}
</div>
{#if current !== undefined && showCurrent}
	<div class="border-b bg-muted/40 px-4 py-2" data-testid="conflict-saved-version">
		<p class="mb-1 text-xs font-medium">Saved version in the folder now</p>
		<pre class="max-h-48 overflow-auto rounded border bg-background p-2 font-mono text-xs whitespace-pre-wrap">{current}</pre>
	</div>
{/if}
