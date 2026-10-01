<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import type { Captures } from '$lib/captures.svelte.js';
	import { downloadText } from '$lib/download.js';
	import type { Draft } from '$lib/draft.svelte.js';
	import TechnicalDetails from './TechnicalDetails.svelte';

	// Shown while a draft cannot simply save: its file changed, went away,
	// cannot be read, or a save failed. Every choice is one explicit action,
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

	const save = $derived(draft.saveState);
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
</script>

{#snippet copyAndDownload()}
	<Button size="sm" variant="outline" disabled={working} onclick={saveCopy}>Save my draft as a copy</Button>
	<Button size="sm" variant="outline" onclick={() => downloadText(name, draft.buffer)}>Download my draft</Button>
{/snippet}

{#if save.kind === 'failed'}
	<Alert.Root variant="destructive" aria-label="Save failed">
		<Alert.Title>The save could not be confirmed</Alert.Title>
		<Alert.Description>Your text is still here. Whether any of it reached the file is not known. Try again checks against the file as this window last read it, or keep your text another way.</Alert.Description>
		<div class="mt-2 flex flex-wrap gap-2 text-foreground">
			<Button size="sm" disabled={working} onclick={() => run(() => draft.retry())}>Try again</Button>
			{@render copyAndDownload()}
			<Button size="sm" variant="destructive" disabled={working} onclick={() => draft.discardMine()}>Discard my changes</Button>
		</div>
		<TechnicalDetails detail={save.message} />
		{#if problem}<p role="status" class="mt-2 text-foreground">{problem}</p>{/if}
	</Alert.Root>
{:else if save.kind === 'conflict'}
	<Alert.Root aria-label="Changed elsewhere">
		{#if save.current.kind === 'present'}
			<Alert.Title>This file was changed outside this window</Alert.Title>
			<Alert.Description>{draft.dirty ? 'Your draft below was not saved over it. Saving is paused until you choose.' : 'The saved file is shown below.'}</Alert.Description>
			<p class="mt-2 text-xs font-medium text-muted-foreground">Saved file now</p>
			<!-- svelte-ignore a11y_no_noninteractive_tabindex: the preview scrolls, so the keyboard must reach it -->
			<pre aria-label="Saved file now" role="region" tabindex="0" class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-xs">{save.current.entry.source}</pre>
			<div class="mt-2 flex flex-wrap gap-2">
				<Button size="sm" variant="outline" disabled={working} onclick={() => draft.loadSaved()}>Load saved (discard my draft)</Button>
				<Button size="sm" disabled={working} onclick={() => run(() => draft.saveMine())}>Save my draft over this version</Button>
				{@render copyAndDownload()}
			</div>
		{:else if save.current.kind === 'removed'}
			<Alert.Title>This file was removed outside this window</Alert.Title>
			<Alert.Description>Your draft is still here. It is not saved anywhere{draft.hasUnsentInput ? ', and neither is the text you typed but had not added' : ''}.</Alert.Description>
			<div class="mt-2 flex flex-wrap gap-2">
				<Button size="sm" disabled={working} onclick={() => run(() => draft.saveMine())}>Save my draft back to this file</Button>
				{@render copyAndDownload()}
				<Button size="sm" variant="destructive" disabled={working} onclick={() => { captures.discard(draft); onBack(); }}>Discard my draft</Button>
			</div>
		{:else}
			<Alert.Title>The saved file cannot be read</Alert.Title>
			<Alert.Description>It is still in the folder, and this window did not write to it. {draft.dirty ? 'Your draft cannot be saved over a file that cannot be reviewed, so keep it another way.' : ''}</Alert.Description>
			<div class="mt-2 flex flex-wrap gap-2">
				<Button size="sm" disabled={working} onclick={() => run(() => draft.check())}>Check again</Button>
				{@render copyAndDownload()}
			</div>
			<TechnicalDetails detail={save.current.message} />
		{/if}
		{#if problem}<p role="status" class="mt-2">{problem}</p>{/if}
	</Alert.Root>
{/if}
