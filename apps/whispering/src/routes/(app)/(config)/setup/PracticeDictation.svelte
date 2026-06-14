<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';
	import XIcon from '@lucide/svelte/icons/x';
	import { onDestroy } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { manualRecorderConfig } from '#platform/manual-recorder-config';
	import { transcribeAudio } from '$lib/operations/transcribe';
	import { services } from '$lib/services';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';

	let {
		disabled = false,
		disabledReason = 'Finish runtime setup before practicing.',
		onSuccess,
	}: {
		disabled?: boolean;
		disabledReason?: string;
		onSuccess?: () => void;
	} = $props();

	let isPracticeRecording = $state(false);
	let isTranscribing = $state(false);
	let transcript = $state('');
	let errorMessage = $state<string | null>(null);

	const canStartPractice = $derived(
		!disabled && !isTranscribing && manualRecorder.state !== 'RECORDING',
	);

	onDestroy(() => {
		if (isPracticeRecording) void manualRecorder.cancelRecording();
	});

	async function startPractice() {
		if (!canStartPractice) return;

		transcript = '';
		errorMessage = null;

		const { data: outcome, error } = await manualRecorder.startRecording();
		if (error) {
			errorMessage = extractErrorMessage(error);
			return;
		}

		if (outcome.outcome !== 'success') {
			manualRecorderConfig.deviceId = outcome.deviceId;
		}

		isPracticeRecording = true;
	}

	async function cancelPractice() {
		if (!isPracticeRecording) return;

		const { error } = await manualRecorder.cancelRecording();
		isPracticeRecording = false;
		if (error) errorMessage = extractErrorMessage(error);
	}

	async function stopAndTranscribePractice() {
		if (!isPracticeRecording) return;

		isTranscribing = true;
		errorMessage = null;

		const { data: source, error: stopError } =
			await manualRecorder.stopRecording();
		isPracticeRecording = false;

		if (stopError) {
			errorMessage = extractErrorMessage(stopError);
			isTranscribing = false;
			return;
		}

		const recordingId =
			source.kind === 'artifact' ? source.artifact.id : source.recordingId;

		try {
			if (source.kind === 'blob') {
				const { error: saveError } = await services.blobs.audio.save(
					recordingId,
					source.blob,
				);
				if (saveError) {
					errorMessage = extractErrorMessage(saveError);
					return;
				}
			}

			const { data: text, error: transcribeError } =
				await transcribeAudio(recordingId);
			if (transcribeError) {
				errorMessage = extractErrorMessage(transcribeError);
				return;
			}

			transcript = text;
			onSuccess?.();
		} finally {
			services.blobs.audio.revokeUrl(recordingId);
			const { error: deleteError } =
				await services.blobs.audio.delete(recordingId);
			if (deleteError && !errorMessage) {
				errorMessage = extractErrorMessage(deleteError);
			}
			isTranscribing = false;
		}
	}
</script>

<div class="space-y-4">
	{#if disabled}
		<Alert.Root variant="warning">
			<AlertCircleIcon class="size-4" />
			<Alert.Title>Runtime setup needed</Alert.Title>
			<Alert.Description>{disabledReason}</Alert.Description>
		</Alert.Root>
	{/if}

	<div class="flex flex-wrap gap-2">
		{#if isPracticeRecording}
			<Button onclick={stopAndTranscribePractice} disabled={isTranscribing}>
				<SquareIcon class="size-4" />
				Stop and transcribe
			</Button>
			<Button
				variant="outline"
				onclick={cancelPractice}
				disabled={isTranscribing}
			>
				<XIcon class="size-4" />
				Cancel
			</Button>
		{:else}
			<Button onclick={startPractice} disabled={!canStartPractice}>
				{#if isTranscribing}
					<Spinner class="size-4" />
				{:else}
					<MicIcon class="size-4" />
				{/if}
				Start practice recording
			</Button>
		{/if}
	</div>

	{#if manualRecorder.state === 'RECORDING' && !isPracticeRecording}
		<Alert.Root variant="warning">
			<AlertCircleIcon class="size-4" />
			<Alert.Title>Recording already in progress</Alert.Title>
			<Alert.Description>
				Stop the active recording before starting a practice dictation.
			</Alert.Description>
		</Alert.Root>
	{/if}

	{#if errorMessage}
		<Alert.Root variant="warning">
			<AlertCircleIcon class="size-4" />
			<Alert.Title>Practice failed</Alert.Title>
			<Alert.Description>{errorMessage}</Alert.Description>
		</Alert.Root>
	{/if}

	<Textarea
		readonly
		rows={8}
		value={transcript}
		placeholder={isTranscribing
			? 'Transcribing practice clip...'
			: 'Your practice transcript appears here.'}
	/>
</div>
