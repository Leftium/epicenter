<!--
	The result of a finished recording: a copyable, expandable transcript preview
	and a player for the captured audio. The home recorder and the first-run "try
	it" step both render this, so the two cannot drift.

	The audio renders whenever the clip exists, independent of the transcript, so a
	silent or not-yet-transcribed recording still plays back. The playback URL is
	owned here: the blob store caches it per id, and it is revoked on teardown.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import TextPreviewDialog from '$lib/components/copyable/TextPreviewDialog.svelte';
	import { rpc } from '$lib/rpc';
	import { services } from '$lib/services';
	import { viewTransition } from '$lib/utils/viewTransitions';

	let {
		recordingId,
		transcript,
		rows = 1,
		onDelete,
	}: {
		recordingId: string;
		transcript: string;
		/** Visible rows of the transcript preview before it scrolls/expands. */
		rows?: number;
		/** When provided, a delete button is shown below the preview. */
		onDelete?: () => void;
	} = $props();

	const audioQuery = createQuery(() => ({
		...rpc.audio.getPlaybackUrl(() => recordingId).options,
		enabled: !!recordingId,
	}));
	onDestroy(() => {
		if (recordingId) services.blobs.audio.revokeUrl(recordingId);
	});
</script>

<div class="flex w-full flex-col gap-2">
	<TextPreviewDialog
		id={viewTransition.recording(recordingId).transcript}
		title="Transcript"
		label="transcript"
		text={transcript}
		{rows}
		disabled={!transcript.trim()}
	/>
	{#if audioQuery.data}
		<audio
			style:view-transition-name={viewTransition.recording(recordingId).audio}
			src={audioQuery.data}
			controls
			class="h-8 w-full"
		></audio>
	{/if}
	{#if onDelete}
		<Button
			class="self-end"
			variant="ghost-destructive"
			size="sm"
			onclick={onDelete}
		>
			<TrashIcon class="size-4" />
			Delete
		</Button>
	{/if}
</div>
