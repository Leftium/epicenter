<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import type { Captures } from '$lib/captures.svelte.js';
	import { downloadText } from '$lib/download.js';
	import type { Draft } from '$lib/draft.svelte.js';
	import TechnicalDetails from './TechnicalDetails.svelte';

	// Shown while a draft does not simply save: a save failed or was not
	// confirmed, a delete was not confirmed, or its file changed elsewhere,
	// became invalid, or cannot be read. Every choice is one explicit action,
	// and none of them runs on its own.
	let {
		draft,
		captures,
		onBack,
		onOpen,
	}: {
		draft: Draft;
		captures: Captures;
		onBack: () => void;
		onOpen: (stem: string) => void;
	} = $props();

	const outcome = $derived(draft.outcome);
	/** What the file holds now, which the person reviews whatever an earlier save did. */
	const review = $derived(draft.review);
	const name = $derived(draft.path.slice(draft.path.lastIndexOf('/') + 1));
	let working = $state(false);
	let problem = $state('');

	async function run(work: () => Promise<unknown>) {
		if (working) return;
		working = true;
		problem = '';
		try {
			await work();
		} finally {
			working = false;
		}
	}

	const saveCopy = () =>
		run(async () => {
			const copied = await captures.saveCopy(draft);
			if (!copied.ok) {
				problem = `The copy was not saved: ${copied.message}`;
				return;
			}
			toast.success('Saved as a new capture');
			onOpen(copied.stem);
		});
	const busy = $derived(working || draft.saving);
</script>

{#snippet copyAndDownload()}
	<Button size="sm" variant="outline" disabled={busy} onclick={saveCopy}>Save my draft as a copy</Button>
	<Button size="sm" variant="outline" onclick={() => downloadText(name, draft.source)}>Download my draft</Button>
{/snippet}

{#if outcome?.kind === 'deletion'}
	<!-- A delete with no answer: the file may be gone. Nothing writes it until a choice. -->
	<Alert.Root variant="destructive" aria-label="Delete not confirmed">
		<Alert.Title>The delete could not be confirmed</Alert.Title>
		<Alert.Description>The file may or may not be gone. This capture stays here, and nothing is written to the file until you choose.</Alert.Description>
		<div class="mt-2 flex flex-wrap gap-2 text-foreground">
			<Button size="sm" disabled={busy || review?.kind === 'unreadable'} onclick={() => run(() => draft.saveMine())}>Keep it: save it to the file</Button>
			{#if draft.editor?.observation.kind === 'present'}
				<Button size="sm" variant="outline" disabled={busy} onclick={() => draft.discardMine()}>Keep it as the file is now</Button>
			{/if}
			{@render copyAndDownload()}
			<Button size="sm" variant="destructive" disabled={busy} onclick={() => { void captures.discard(draft); onBack(); }}>Let it go</Button>
		</div>
		<TechnicalDetails detail={outcome.message} />
		{#if problem}<p role="status" class="mt-2 text-foreground">{problem}</p>{/if}
	</Alert.Root>
{:else if outcome}
	<!-- What became of an earlier save. What the file holds now is shown below, on its own. -->
	<Alert.Root variant="destructive" aria-label="Save failed">
		{#if outcome.kind === 'unconfirmed'}
			<Alert.Title>The save could not be confirmed</Alert.Title>
			<Alert.Description>
				Your text is still here. Whether that save reached the file is not known, and nothing is sent again until you choose.
				{#if outcome.fileHoldsMine}The file as last read holds this text, but that does not confirm the save.{/if}
			</Alert.Description>
		{:else}
			<Alert.Title>The save failed</Alert.Title>
			<Alert.Description>Your text is still here and was not saved. Nothing is sent again until you choose.</Alert.Description>
		{/if}
		<div class="mt-2 flex flex-wrap gap-2 text-foreground">
			{#if review === undefined}
				<Button size="sm" disabled={busy} onclick={() => run(() => draft.saveMine())}>Try again</Button>
			{/if}
			{@render copyAndDownload()}
			{#if review === undefined}
				<Button size="sm" variant="destructive" disabled={busy} onclick={() => draft.discardMine()}>Discard my changes</Button>
			{/if}
		</div>
		<TechnicalDetails detail={outcome.message} />
		{#if problem && !review}<p role="status" class="mt-2 text-foreground">{problem}</p>{/if}
	</Alert.Root>
{/if}
{#if review}
	<Alert.Root aria-label="Changed elsewhere">
		{#if review.kind === 'changed'}
			<Alert.Title>This file was changed outside this window</Alert.Title>
			<Alert.Description>Your draft below was not saved over it. Saving is paused until you choose.</Alert.Description>
			<p class="mt-2 text-xs font-medium text-muted-foreground">Saved file now</p>
			<!-- svelte-ignore a11y_no_noninteractive_tabindex: the preview scrolls, so the keyboard must reach it -->
			<pre aria-label="Saved file now" role="region" tabindex="0" class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-xs">{review.revision.text}</pre>
			<div class="mt-2 flex flex-wrap gap-2">
				<Button size="sm" variant="outline" disabled={busy} onclick={() => draft.loadSaved()}>Load saved (discard my draft)</Button>
				<Button size="sm" disabled={busy} onclick={() => run(() => draft.saveMine())}>Save my draft over this version</Button>
				{@render copyAndDownload()}
			</div>
		{:else if review.kind === 'invalid'}
			<Alert.Title>This file was changed outside this window, and is not a valid capture</Alert.Title>
			<Alert.Description>{draft.dirty ? 'Your draft below was not saved over it. Saving is paused until you choose.' : 'The window still shows the capture as it was.'}</Alert.Description>
			<p class="mt-2 text-xs font-medium text-muted-foreground">Saved file now</p>
			<!-- svelte-ignore a11y_no_noninteractive_tabindex: the preview scrolls, so the keyboard must reach it -->
			<pre aria-label="Saved file now" role="region" tabindex="0" class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-xs">{review.file.text}</pre>
			<div class="mt-2 flex flex-wrap gap-2">
				<Button size="sm" variant="outline" disabled={busy} onclick={() => run(() => draft.repairFile())}>Repair the saved file in Source (discard my draft)</Button>
				<Button size="sm" disabled={busy} onclick={() => run(() => draft.saveMine())}>Save my draft over it</Button>
				{@render copyAndDownload()}
			</div>
			<TechnicalDetails detail={review.message} />
		{:else}
			<Alert.Title>The saved file cannot be read</Alert.Title>
			<Alert.Description>It is still in the folder, and this window did not write to it. {draft.dirty ? 'Your draft cannot be saved over a file that cannot be reviewed, so keep it another way.' : ''}</Alert.Description>
			<div class="mt-2 flex flex-wrap gap-2">
				<Button size="sm" disabled={busy} onclick={() => run(() => draft.check())}>Check again</Button>
				{@render copyAndDownload()}
			</div>
			<TechnicalDetails detail={review.message} />
		{/if}
		{#if problem}<p role="status" class="mt-2">{problem}</p>{/if}
	</Alert.Root>
{/if}
