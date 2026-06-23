<script lang="ts">
	import type { Snippet } from 'svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import { createVadRecordingController } from './vad-recording-controller.svelte';
	import RecordingActionCard from './RecordingActionCard.svelte';

	let {
		pipeline,
	}: {
		pipeline: Snippet;
	} = $props();

	const rec = createVadRecordingController();
</script>

<RecordingActionCard
	controller={rec}
	footer={pipeline}
	iconViewTransitionName={viewTransition.recordingMode('vad')}
/>
