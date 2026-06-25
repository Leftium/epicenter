<script lang="ts">
	import { Skeleton } from '@epicenter/ui/skeleton';
	import { recordings } from '$lib/state/recordings.svelte';
	import TranscribeRecordingButton from './TranscribeRecordingButton.svelte';
	import TransformationPicker from './TransformationPicker.svelte';

	/**
	 * The compact per-row actions: only the things worth firing without opening
	 * anything. Transcribe and transform are the hot path.
	 *
	 * Everything else has a better home and was duplicating it here: copy lives
	 * in the transcript and transformation-output cells already, and download,
	 * run history, and delete live in the recording detail modal (open it by
	 * clicking the transcript). Keeping the row lean stops it from re-offering
	 * what its neighboring columns and the modal already do.
	 */
	let { recordingId }: { recordingId: string } = $props();

	const recording = $derived(recordings.get(recordingId));
</script>

<div class="flex items-center gap-1">
	{#if !recording}
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
	{:else}
		<TranscribeRecordingButton {recording} />
		<TransformationPicker recordingId={recording.id} />
	{/if}
</div>
