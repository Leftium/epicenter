<!--
	The open word's save state, and the conflict prompt. A change made
	elsewhere asks "Reload theirs" or "Keep mine"; a file deleted elsewhere
	asks "Discard" or "Keep mine", which creates it again from the draft. Any
	other failed save offers "Try again". A draft that is not a valid word is
	never written; the message names what to fix. Shows nothing once saved.
-->
<script lang="ts">
	import type { AutosaveError, FileError, RowSaveError, SaveState } from '@epicenter/folder';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';

	let {
		save,
		onRetry,
		onKeepMine,
		onReloadTheirs,
	}: {
		save: SaveState<RowSaveError | FileError | AutosaveError>;
		onRetry: () => void;
		/** Answers what the learner is told, if anything. */
		onKeepMine: () => Promise<string | undefined>;
		onReloadTheirs: () => Promise<string | undefined>;
	} = $props();

	let choosing = $state(false);

	async function choose(run: () => Promise<string | undefined>) {
		choosing = true;
		const problem = await run();
		choosing = false;
		if (problem) toast.error('Could not resolve the conflict', { description: problem });
	}

	const error = $derived(save.status === 'error' ? save.error : undefined);
</script>

{#if error || save.status === 'saving'}
	<div class="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="save-status">
		{#if error?.name === 'Conflict'}
			<span class="text-destructive" role="alert">
				{error.actualSha256 === undefined
					? 'This was deleted elsewhere. Your edits are kept here and not saved.'
					: 'This changed elsewhere. Your edits are kept here and not saved.'}
			</span>
			<Button size="xs" variant="outline" disabled={choosing} onclick={() => void choose(onReloadTheirs)}>
				{error.actualSha256 === undefined ? 'Discard' : 'Reload theirs'}
			</Button>
			<Button size="xs" disabled={choosing} onclick={() => void choose(onKeepMine)}>Keep mine</Button>
		{:else if error?.name === 'InvalidValues'}
			<span class="text-destructive" role="alert">
				Not saved: {error.issues.map((issue) => issue.message).join(' ')}
			</span>
		{:else if error?.name === 'Unconfirmed'}
			<span class="text-destructive" role="alert">
				The save was sent, but nothing confirmed it, so it may or may not be in the file.
			</span>
			<Button size="xs" onclick={onRetry}>Save again</Button>
		{:else if error}
			<span class="text-destructive" role="alert">Not saved: {error.message}</span>
			<Button size="xs" onclick={onRetry}>Try again</Button>
		{:else}
			<span class="text-muted-foreground">Saving…</span>
		{/if}
	</div>
{/if}
