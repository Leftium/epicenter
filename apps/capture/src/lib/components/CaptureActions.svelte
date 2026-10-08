<!--
	A capture file's More menu and its deletion review, the same in the
	capture view and in Files: both act on the one draft the page holds for
	the file.

	Deleting settles the capture, reads the saved file as it is now, and
	deletes exactly what the person saw, without reading it again. The review
	is the draft's, so it outlives this view; a delete once sent runs to its
	answer wherever the views are. Publication commands return once this view is
	destroyed.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { toast } from '@epicenter/ui/sonner';
	import { onDestroy } from 'svelte';
	import type { Captures } from '$lib/captures.svelte.js';
	import { copyText, downloadText } from '$lib/download.js';
	import type { Draft } from '$lib/draft.svelte.js';

	let {
		draft,
		captures,
		onDeleted,
	}: {
		/** The draft of the view this belongs to, for its whole lifetime. */
		draft: Draft;
		captures: Captures;
		/** Completion belongs to the app container even after deletion removes this view. */
		onDeleted: (stem: string) => void;
	} = $props();

	let mounted = true;
	onDestroy(() => {
		mounted = false;
	});

	/** Nothing a person does is taken: leaving, deleting, or another operation holds it. */
	const held = $derived(!draft.admitted);

	async function copy() {
		if (await copyText(draft.source)) toast.success('File text copied');
		else toast.error(`Could not copy. Select the text and copy it.`);
	}

	/** A delete can be sent now: not leaving, not closing, not let go, not already sending. */
	const mayDelete = $derived(!captures.fenced && !draft.retired && !draft.removing);
	function cancelDeletion() {
		if (!mounted) return;
		draft.cancelDeletion();
	}
	async function confirmDeletion() {
		if (!mounted || !mayDelete) return;
		const deletedStem = draft.stem;
		const completed = onDeleted;
		if (await captures.remove(draft)) completed(deletedStem);
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="sm" aria-label="More capture actions">More</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-48">
		<DropdownMenu.Item onclick={copy}>Copy file text</DropdownMenu.Item>
		<DropdownMenu.Item onclick={() => downloadText(`${draft.stem}.md`, draft.source)}>Download file</DropdownMenu.Item>
		<!-- Shows the file as it is now, in place of what this window shows. A choice waiting for the person has its own. -->
		<DropdownMenu.Item disabled={held || draft.notice !== undefined} onclick={() => {
			if (!mounted || held) return;
			void draft.reload();
		}}>Reload from file</DropdownMenu.Item>
		<DropdownMenu.Separator />
		<DropdownMenu.Item variant="destructive" disabled={held} onclick={() => {
			if (!mounted || held) return;
			void captures.reviewDeletion(draft);
		}}>Delete capture…</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>

<Dialog.Root bind:open={() => draft.deletionReview !== undefined, (open) => { if (!open) cancelDeletion(); }}>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>Permanently delete this capture file?</Dialog.Title>
			<Dialog.Description>This is the saved file as it is now. Its thoughts are part of it and go with it. Recorded earlier versions remain in Git history.</Dialog.Description>
		</Dialog.Header>
		<div class="flex min-w-0 flex-col gap-3">
			{#if draft.hasUnsentInput || draft.notice !== undefined}<p class="font-medium">Text in this window that is not saved will be discarded too.</p>{/if}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex: the preview scrolls, so the keyboard must reach it -->
			<pre aria-label="Saved file" role="region" tabindex="0" class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-xs">{draft.deletionReview?.entry.text}</pre>
			{#if draft.deletionReview?.problem}<p role="status">{draft.deletionReview.problem}</p>{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" disabled={draft.removing} onclick={cancelDeletion}>Cancel</Button>
			<Button variant="destructive" disabled={!mayDelete} onclick={confirmDeletion}>{draft.removing ? 'Deleting…' : 'Permanently delete'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
