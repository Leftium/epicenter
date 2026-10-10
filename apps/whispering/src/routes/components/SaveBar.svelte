<!--
	One open draft's save state, and the conflict prompt. A change made
	elsewhere asks "Reload theirs" or "Keep mine"; a file deleted elsewhere
	asks "Discard" or "Keep mine", which creates it again from the draft. A
	recording deleted elsewhere offers only Discard: its audio may be gone
	too. Any other failed save offers "Try again". A draft that is not a
	valid row is never written; the message names what to fix.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import type { DraftSession, Library } from '$lib/library.svelte.js';

	let { library, session, compact = false }: {
		library: Library;
		session: DraftSession;
		/** Show nothing while saved, as beside a transcript. */
		compact?: boolean;
	} = $props();

	let choosing = $state(false);

	async function choose(run: () => Promise<string | undefined>) {
		choosing = true;
		const problem = await run();
		choosing = false;
		if (problem) toast.error('Could not resolve the conflict', { description: problem });
	}

	const save = $derived(session.state);
	const error = $derived(save.status === 'error' ? save.error : undefined);
	/** Deleted elsewhere, or a recording whose Keep mine found it deleted: only Discard is left. */
	const gone = $derived(
		error?.name === 'Conflict' && (error.actualSha256 === undefined || !library.canKeepMine(session)),
	);
</script>

{#if !compact || save.status !== 'saved'}
	<div class="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs" data-testid="save-bar" data-save-state={save.status}>
		{#if error?.name === 'Conflict'}
			<span class="text-destructive" role="alert">
				{gone
					? 'This was deleted elsewhere. Your edits are kept here and not saved.'
					: 'This changed elsewhere. Your edits are kept here and not saved.'}
			</span>
			<Button size="xs" variant="outline" disabled={choosing} onclick={() => void choose(() => library.reloadTheirs(session))}>
				{gone ? 'Discard' : 'Reload theirs'}
			</Button>
			{#if library.canKeepMine(session)}
				<Button size="xs" disabled={choosing} onclick={() => void choose(() => library.keepMine(session))}>Keep mine</Button>
			{/if}
		{:else if error?.name === 'InvalidValues'}
			<span class="text-destructive" role="alert">
				Not saved: {error.issues.map((issue) => issue.message).join(' ')}
			</span>
		{:else if error?.name === 'Unconfirmed'}
			<span class="text-destructive" role="alert">
				The save was sent, but nothing confirmed it, so it may or may not be in the file.
			</span>
			<Button size="xs" onclick={() => session.retry()}>Save again</Button>
		{:else if error}
			<span class="text-destructive" role="alert">Not saved: {error.message}</span>
			<Button size="xs" onclick={() => session.retry()}>Try again</Button>
		{:else if save.status === 'saving'}
			<span class="text-muted-foreground">Saving…</span>
		{:else}
			<span class="text-muted-foreground">Saved to <code class="font-mono">{save.file.path}</code></span>
		{/if}
	</div>
{/if}
