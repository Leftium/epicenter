<!--
	One edit session's save state, and the conflict prompt.

	A change made elsewhere asks "Reload theirs" or "Keep mine". A file
	deleted elsewhere asks "Discard" or "Keep mine", which creates it again
	from the draft; without `onKeepMine` only Discard is offered. Any other
	failed save offers "Try again", and a save whose reply was lost "Save
	again". A draft that is not a valid row is never written; the bar names
	what to fix.
-->
<script lang="ts">
	import type { SaveState } from '@epicenter/folder';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';

	type Failure = {
		readonly name: string;
		readonly message: string;
		readonly actualSha256?: string;
		readonly issues?: readonly { readonly message: string }[];
	};

	let {
		save,
		onRetry,
		onReloadTheirs,
		onKeepMine,
		hideWhenSaved = false,
		class: className = '',
	}: {
		save: SaveState<Failure>;
		onRetry: () => void;
		/** Answers what the person is told, if anything. */
		onReloadTheirs: () => Promise<string | undefined>;
		/** Omitted when the file cannot be restored; only Discard is offered then. */
		onKeepMine?: () => Promise<string | undefined>;
		/** Show nothing while every save has landed. */
		hideWhenSaved?: boolean;
		class?: string;
	} = $props();

	let choosing = $state(false);

	async function choose(run: () => Promise<string | undefined>) {
		choosing = true;
		const problem = await run();
		choosing = false;
		if (problem) toast.error('Could not resolve the conflict', { description: problem });
	}

	const error = $derived(save.status === 'error' ? save.error : undefined);
	const gone = $derived(error?.name === 'Conflict' && error.actualSha256 === undefined);
</script>

{#if !(hideWhenSaved && save.status === 'saved')}
	<div
		class="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs {className}"
		data-testid="save-bar"
	>
		{#if error?.name === 'Conflict'}
			<span class="text-destructive" role="alert">
				{gone
					? 'This was deleted elsewhere. Your edits are kept here and not saved.'
					: 'This changed elsewhere. Your edits are kept here and not saved.'}
			</span>
			<Button size="xs" variant="outline" disabled={choosing} onclick={() => void choose(onReloadTheirs)}>
				{gone ? 'Discard' : 'Reload theirs'}
			</Button>
			{#if onKeepMine}
				<Button size="xs" disabled={choosing} onclick={() => void choose(onKeepMine)}>Keep mine</Button>
			{/if}
		{:else if error?.name === 'InvalidValues'}
			<span class="text-destructive" role="alert">
				Not saved: {error.issues?.map((issue) => issue.message).join(' ') ?? error.message}
			</span>
		{:else if error?.name === 'Unconfirmed'}
			<span class="text-destructive" role="alert">
				The save was sent, but nothing confirmed it, so it may or may not be in the file.
			</span>
			<Button size="xs" onclick={onRetry}>Save again</Button>
		{:else if error}
			<span class="text-destructive" role="alert">Not saved: {error.message}</span>
			<Button size="xs" onclick={onRetry}>Try again</Button>
		{:else if save.status === 'saving'}
			<span class="text-muted-foreground">Saving…</span>
		{:else}
			<span class="text-muted-foreground">Saved to <code class="font-mono">{save.file.path}</code></span>
		{/if}
	</div>
{/if}
