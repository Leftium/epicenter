<script lang="ts">
	import MicIcon from '@lucide/svelte/icons/mic';
	import { createMutation } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import {
		startManualRecording,
		stopManualRecording,
	} from '$lib/operations/recording';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { getShortcutDisplayLabel } from '$lib/utils/keyboard';
	import RecordingActionCard from './RecordingActionCard.svelte';

	let {
		pipeline,
	}: {
		pipeline: Snippet;
	} = $props();

	const startMutation = createMutation(() => ({
		mutationFn: startManualRecording,
	}));
	const stopMutation = createMutation(() => ({
		mutationFn: stopManualRecording,
	}));

	const isStarting = $derived(startMutation.isPending);
	const isStopping = $derived(stopMutation.isPending);
	const isPending = $derived(isStarting || isStopping);
	const isRecording = $derived(manualRecorder.state === 'RECORDING');
	const shortcutLabel = $derived(
		getShortcutDisplayLabel(settings.get('shortcut.toggleManualRecording')),
	);
	const label = $derived(isRecording ? 'Stop recording' : 'Start recording');
	const idleDescription = $derived(
		shortcutLabel ? 'Click or press shortcut' : 'Click to record',
	);
	const description = $derived.by(() => {
		if (isStarting) return 'Opening microphone input';
		if (isStopping) return 'Stopping recording';
		if (isRecording) return 'Click again to stop';
		return idleDescription;
	});
	const tooltip = $derived.by(() => {
		if (isStarting) return 'Preparing recording controls';
		if (isStopping) return 'Stopping recording';
		return label;
	});

	function handleClick() {
		if (isRecording) {
			stopMutation.mutate();
		} else {
			startMutation.mutate();
		}
	}
</script>

<RecordingActionCard
	active={isRecording}
	{description}
	footer={isRecording ? undefined : pipeline}
	icon={MicIcon}
	label={label}
	pending={isPending}
	{shortcutLabel}
	{tooltip}
	onclick={handleClick}
/>
