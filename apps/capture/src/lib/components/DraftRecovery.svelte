<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import type { Captures } from '$lib/captures.svelte.js';
	import { downloadText } from '$lib/download.js';
	import type { Draft } from '$lib/draft.svelte.js';
	import TechnicalDetails from './TechnicalDetails.svelte';

	// Shown while saving waits for the person: a save failed or was not
	// confirmed, a delete was not confirmed, or a reload found no file. Every
	// choice is one explicit action, and none of them runs on its own.
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

	const name = $derived(draft.path.slice(draft.path.lastIndexOf('/') + 1));
	let working = $state(false);
	let problem = $state('');

	async function run(work: () => Promise<unknown> | unknown) {
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
	const restore = () =>
		run(async () => {
			const restored = await draft.restore();
			if (!restored.ok) problem = `The file was not put back: ${restored.message}`;
		});
	const letGo = () =>
		run(async () => {
			await captures.discard(draft);
			onBack();
		});
	const busy = $derived(working || !draft.admitted || draft.saving);
</script>

{#snippet copyAndDownload()}
	<Button size="sm" variant="outline" disabled={busy} onclick={saveCopy}>Save my text as a copy</Button>
	<Button size="sm" variant="outline" onclick={() => downloadText(name, draft.source)}>Download my text</Button>
{/snippet}

{#if draft.notice?.kind === 'deletion'}
	<!-- A delete with no answer: the file may be gone. Nothing writes it until a choice. -->
	<Alert.Root variant="destructive" aria-label="Delete not confirmed">
		<Alert.Title>The delete could not be confirmed</Alert.Title>
		<Alert.Description>The file may or may not be gone. This capture stays here, and nothing is written to the file until you choose.</Alert.Description>
		<div class="mt-2 flex flex-wrap gap-2 text-foreground">
			<Button size="sm" variant="outline" disabled={busy} onclick={() => run(() => draft.reload())}>Keep it as the file is now</Button>
			<Button size="sm" variant="outline" disabled={busy} onclick={restore}>Keep it: put the file back</Button>
			{@render copyAndDownload()}
			<Button size="sm" variant="destructive" disabled={busy} onclick={letGo}>Let it go</Button>
		</div>
		<TechnicalDetails detail={draft.notice.message} />
		{#if problem}<p role="status" class="mt-2 text-foreground">{problem}</p>{/if}
	</Alert.Root>
{:else if draft.notice?.kind === 'removed'}
	<Alert.Root variant="destructive" aria-label="File removed">
		<Alert.Title>This file is not in the folder</Alert.Title>
		<Alert.Description>Your text is still here. Saving never puts the file back; you can, or save a copy.</Alert.Description>
		<div class="mt-2 flex flex-wrap gap-2 text-foreground">
			<Button size="sm" disabled={busy} onclick={restore}>Put the file back</Button>
			{@render copyAndDownload()}
			<Button size="sm" variant="outline" disabled={busy} onclick={() => run(() => draft.reload())}>Check again</Button>
			<Button size="sm" variant="destructive" disabled={busy} onclick={letGo}>Let it go</Button>
		</div>
		{#if problem}<p role="status" class="mt-2 text-foreground">{problem}</p>{/if}
	</Alert.Root>
{:else if draft.notice}
	<Alert.Root variant="destructive" aria-label="Save failed">
		{#if draft.notice.kind === 'unconfirmed'}
			<Alert.Title>The save could not be confirmed</Alert.Title>
			<Alert.Description>
				<p>Your text is still here. Whether that save reached the file is not known, and nothing is saved until you choose. A later read that finds your text says what the file holds, not that this save landed.</p>
				<!-- The exact report: it names where a displaced file was kept, when one was. -->
				<p class="mt-1 font-medium break-words">{draft.notice.message}</p>
			</Alert.Description>
		{:else if draft.notice.missing}
			<Alert.Title>The file was removed, so the save did not land</Alert.Title>
			<Alert.Description>Your text is still here. Saving never creates the file again. Put it back, save a copy, or download your text.</Alert.Description>
		{:else}
			<Alert.Title>The save failed</Alert.Title>
			<Alert.Description>Your text is still here and was not saved. Nothing is saved until you choose.</Alert.Description>
		{/if}
		<div class="mt-2 flex flex-wrap gap-2 text-foreground">
			{#if draft.notice.kind === 'failed' && draft.notice.missing}
				<Button size="sm" disabled={busy} onclick={restore}>Put the file back</Button>
			{/if}
			<!-- Sends the latest text over whatever the file holds now. -->
			<Button size="sm" disabled={busy} onclick={() => draft.retry()}>Try again</Button>
			{@render copyAndDownload()}
			{#if draft.notice.kind === 'failed' && draft.notice.missing}
				<Button size="sm" variant="destructive" disabled={busy} onclick={letGo}>Let it go</Button>
			{:else}
				<Button size="sm" variant="destructive" disabled={busy} onclick={() => run(() => draft.reload())}>Discard my changes</Button>
			{/if}
		</div>
		{#if draft.notice.kind !== 'unconfirmed'}<TechnicalDetails detail={draft.notice.message} />{/if}
		{#if problem}<p role="status" class="mt-2 text-foreground">{problem}</p>{/if}
	</Alert.Root>
{/if}
