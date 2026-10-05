<script lang="ts" generics="TFields">
	import { toast } from '@epicenter/ui/sonner';
	import type { Library } from '$lib/library.svelte.js';
	import type { RowEditing } from '$lib/row-editing.svelte.js';
	import { copyText } from './file-actions.js';
	import LiveButton from './LiveButton.svelte';

	/**
	 * One open row's save, in the row editor's terms. Typing is saved as it
	 * is typed. A write that failed or was never answered keeps the edits on
	 * screen and stops saving until the person saves again; an unknown one
	 * stays unknown even when the file holds the same text. The file is read
	 * again only when the person asks, which replaces what is shown.
	 *
	 * `editing` can be another path's on the next render, so every action
	 * reads it when it runs. Each action button has its own lifetime: one
	 * shown for an earlier state does nothing once it is gone, even when that
	 * state returns.
	 */
	let { library, editing }: { library: Library; editing: RowEditing<TFields> } = $props();

	async function reload() {
		const problem = await library.reloadRow(editing.path);
		if (problem) toast.error('The file was not loaded', { description: problem });
	}

	function retry() {
		const problem = editing.retry();
		if (problem) toast.error('Nothing was saved', { description: problem });
	}
</script>

<div class="flex min-h-9 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs" data-testid="save-status" data-save-state={editing.status.kind}>
	{#if editing.status.kind === 'saving'}
		<span class="text-muted-foreground">Saving…</span>
	{:else if editing.status.kind === 'failed' || editing.status.kind === 'unconfirmed'}
		<span class="text-destructive" role="alert">
			{editing.status.kind === 'failed'
				? `Not saved: ${editing.status.message}.`
				: `The last save was not confirmed, so it may or may not be in the file: ${editing.status.message}`}
			Your edits are kept here, and saving has stopped until you save again.
		</span>
		<LiveButton size="xs" variant="outline" onclick={retry}>Save again</LiveButton>
		<LiveButton size="xs" variant="outline" onclick={() => void reload()}>Discard mine and load the file</LiveButton>
	{:else if editing.status.kind === 'removed'}
		<span class="text-destructive" role="alert">
			{editing.status.message}. Your edits are kept here and not saved.
		</span>
		<LiveButton size="xs" variant="outline" onclick={() => void copyText(editing.row.text, 'your edits')}>Copy mine</LiveButton>
		<LiveButton size="xs" variant="outline" onclick={async () => {
			const problem = await library.discardDraft(editing.path);
			if (problem) toast.error('Nothing was discarded', { description: problem });
		}}>Discard mine</LiveButton>
	{:else if editing.status.kind === 'refused'}
		<span class="text-warning" role="alert">
			What you typed in {editing.status.controls.join(', ')} cannot be saved: {editing.status.message}. It is kept there and
			not saved; change it there, or discard it.
		</span>
		{#each editing.status.controls as control (control)}
			<LiveButton size="xs" variant="outline" onclick={() => editing.dropRefused(control)}>
				Discard what was typed in {control}
			</LiveButton>
		{/each}
	{:else}
		{#if editing.status.kind === 'invalid'}
			<span class="text-warning" role="status">Saved, and it needs repair in Source: {editing.status.message}.</span>
		{:else}
			<span class="text-muted-foreground">Saved to <code class="font-mono">{editing.path}</code></span>
		{/if}
		<LiveButton size="xs" variant="ghost" class="ml-auto" onclick={() => void reload()} data-testid="reload-row">Reload from file</LiveButton>
	{/if}
</div>
