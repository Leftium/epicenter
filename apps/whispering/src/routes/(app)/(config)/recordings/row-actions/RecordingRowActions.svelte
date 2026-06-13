<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import { Spinner } from '@epicenter/ui/spinner';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import FileStackIcon from '@lucide/svelte/icons/file-stack';
	import PlayIcon from '@lucide/svelte/icons/play';
	import RepeatIcon from '@lucide/svelte/icons/repeat';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { createMutation } from '@tanstack/svelte-query';
	import type { AnyTaggedError } from 'wellcrafted/error';
	import { deliverTranscriptionResult } from '$lib/operations/delivery';
	import { sound } from '$lib/operations/sound';
	import { report } from '$lib/report';
	import { rpc } from '$lib/rpc';
	import { recordings } from '$lib/state/recordings.svelte';
	import { transformationRuns } from '$lib/state/transformation-runs.svelte';
	import { createCopyFn } from '$lib/utils/createCopyFn';
	import { recordingActions } from '$lib/utils/recording-actions';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import EditRecordingModal from './EditRecordingModal.svelte';
	import TransformationPicker from './TransformationPicker.svelte';
	import ViewTransformationRunsDialog from './ViewTransformationRunsDialog.svelte';

	const transcribeRecording = createMutation(
		() => rpc.transcription.transcribeRecording.options,
	);

	const downloadRecording = createMutation(
		() => rpc.download.downloadRecording.options,
	);

	let { recordingId }: { recordingId: string } = $props();

	const latestRun = $derived(
		transformationRuns.getLatestByRecordingId(recordingId),
	);

	const recording = $derived(recordings.get(recordingId));

	// Liveness is the in-flight mutation, not a stored field: while this row's
	// transcription is pending it reads as transcribing, otherwise the stored
	// outcome (or its absence) decides the state.
	const transcriptionStatus = $derived.by(() => {
		if (transcribeRecording.isPending) return 'transcribing' as const;
		return recording?.transcription?.status ?? 'unprocessed';
	});
</script>

<div class="flex items-center gap-1">
	{#if !recording}
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
	{:else}
		<Button
			tooltip={transcriptionStatus === 'unprocessed'
				? 'Start transcribing this recording'
				: transcriptionStatus === 'transcribing'
					? 'Currently transcribing...'
					: transcriptionStatus === 'completed'
						? 'Retry transcription'
						: recording.transcription?.status === 'failed'
							? `Transcription failed: ${recording.transcription.error}. Click to retry`
							: 'Transcription failed. Click to retry'}
			onclick={() => {
				const loading = report.loading({
					title: 'Transcribing...',
					description: 'Your recording is being transcribed...',
				});
				transcribeRecording.mutate(recording, {
					onError: (error) => {
						loading.reject({
							cause: error as AnyTaggedError,
							title: 'Failed to transcribe recording',
							description: 'Your recording could not be transcribed.',
						});
					},
					onSuccess: async (transcribedText) => {
						sound.playSoundIfEnabled('transcriptionComplete');

						const notice = await deliverTranscriptionResult({
							text: transcribedText,
						});
						loading.resolve(notice);
					},
				});
			}}
			variant="ghost"
			size="icon"
		>
			{#if transcriptionStatus === 'unprocessed'}
				<PlayIcon class="size-4" />
			{:else if transcriptionStatus === 'transcribing'}
				<EllipsisIcon class="size-4" />
			{:else if transcriptionStatus === 'completed'}
				<RepeatIcon class="size-4 text-green-500" />
			{:else if transcriptionStatus === 'failed'}
				<RotateCcwIcon class="size-4 text-red-500" />
			{/if}
		</Button>

		<TransformationPicker recordingId={recording.id} />

		<EditRecordingModal {recording} />

		<CopyButton
			text={recording.transcript}
			copyFn={createCopyFn('transcript')}
			style="view-transition-name: {viewTransition.recording(recordingId)
				.transcript}"
		/>

		{#if latestRun?.result?.status === 'completed'}
			<CopyButton
				text={latestRun.result.output}
				copyFn={createCopyFn('latest transformation run output')}
				style="view-transition-name: {viewTransition.recording(recordingId)
					.transformationOutput}"
			>
				{#snippet icon()}
					<FileStackIcon class="size-4" />
				{/snippet}
			</CopyButton>
		{/if}

		<ViewTransformationRunsDialog {recordingId} />

		<Button
			tooltip="Download recording"
			onclick={() =>
				downloadRecording.mutate(recording, {
					onError: (error) => {
						report.error({
							cause: error as AnyTaggedError,
							title: 'Failed to download recording!',
							description: 'Your recording could not be downloaded.',
						});
					},
					onSuccess: () => {
						report.success({
							title: 'Recording downloaded!',
							description: 'Your recording has been downloaded.',
						});
					},
				})}
			variant="ghost"
			size="icon"
		>
			{#if downloadRecording.isPending}
				<Spinner />
			{:else}
				<DownloadIcon class="size-4" />
			{/if}
		</Button>

		<Button
			tooltip="Delete recording"
			onclick={() => recordingActions.deleteWithConfirmation(recording)}
			variant="ghost"
			size="icon"
		>
			<TrashIcon class="size-4" />
		</Button>
	{/if}
</div>
