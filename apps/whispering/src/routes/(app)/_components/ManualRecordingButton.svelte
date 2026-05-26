<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createMutation } from '@tanstack/svelte-query';
	import { RECORDER_STATE_TO_ICON } from '$lib/constants/audio';
	import {
		startManualRecording,
		stopManualRecording,
	} from '$lib/operations/recording';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';

	const startMutation = createMutation(() => ({
		mutationFn: startManualRecording,
	}));
	const stopMutation = createMutation(() => ({
		mutationFn: stopManualRecording,
	}));

	const isPreparing = $derived(
		startMutation.isPending || stopMutation.isPending,
	);
	const tooltip = $derived(
		isPreparing
			? 'Preparing...'
			: manualRecorder.state === 'IDLE'
				? 'Start recording'
				: 'Stop recording',
	);

	function handleClick() {
		if (manualRecorder.state === 'RECORDING') {
			stopMutation.mutate();
		} else {
			startMutation.mutate();
		}
	}
</script>

<Button
	{tooltip}
	disabled={isPreparing}
	onclick={handleClick}
	variant="ghost"
	class="shrink-0 size-32 sm:size-36 lg:size-40 xl:size-44 transform items-center justify-center overflow-hidden duration-300 ease-in-out"
>
	<span
		style="filter: drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.5)); view-transition-name: {viewTransition
			.global.microphone};"
		class="text-[100px] sm:text-[110px] lg:text-[120px] xl:text-[130px] leading-none"
	>
		{#if isPreparing}
			<Spinner class="size-24 sm:size-28 lg:size-32 xl:size-36" />
		{:else}
			{RECORDER_STATE_TO_ICON[manualRecorder.state]}
		{/if}
	</span>
</Button>
