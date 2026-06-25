<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import FileStackIcon from '@lucide/svelte/icons/file-stack';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { deleteRecordingsWithConfirmation } from '$lib/operations/recordings';
	import { recordings } from '$lib/state/recordings.svelte';
	import { transformationRuns } from '$lib/state/transformation-runs.svelte';
	import { createCopyFn } from '$lib/utils/createCopyFn';
	import DownloadRecordingButton from './DownloadRecordingButton.svelte';
	import TranscribeRecordingButton from './TranscribeRecordingButton.svelte';
	import TransformationPicker from './TransformationPicker.svelte';
	import ViewTransformationRunsDialog from './ViewTransformationRunsDialog.svelte';

	let { recordingId }: { recordingId: string } = $props();

	const latestRun = $derived(
		transformationRuns.getLatestByRecordingId(recordingId),
	);

	const recording = $derived(recordings.get(recordingId));
</script>

<div class="flex items-center gap-1">
	{#if !recording}
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
	{:else}
		<TranscribeRecordingButton {recording} />

		<TransformationPicker recordingId={recording.id} />

		<CopyButton
			text={recording.transcript}
			copyFn={createCopyFn('transcript')}
		/>

		{#if latestRun?.result?.status === 'completed'}
			<CopyButton
				text={latestRun.result.output}
				copyFn={createCopyFn('latest transformation run output')}
			>
				{#snippet icon()}
					<FileStackIcon class="size-4" />
				{/snippet}
			</CopyButton>
		{/if}

		<ViewTransformationRunsDialog {recordingId} />

		<DownloadRecordingButton {recording} />

		<Button
			tooltip="Delete recording"
			onclick={() => deleteRecordingsWithConfirmation(recording)}
			variant="ghost"
			size="icon"
		>
			<TrashIcon class="size-4" />
		</Button>
	{/if}
</div>
