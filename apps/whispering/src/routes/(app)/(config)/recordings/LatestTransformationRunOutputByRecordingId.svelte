<script lang="ts">
	import TextPreviewDialog from '$lib/components/copyable/TextPreviewDialog.svelte';
	import { workspaceTransformationRuns } from '$lib/state/workspace-transformation-runs.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';

	let {
		recordingId,
	}: {
		recordingId: string;
	} = $props();

	const latestRun = $derived(
		workspaceTransformationRuns.getLatestByRecordingId(recordingId),
	);

	const id = $derived(
		viewTransition.recording(recordingId).transformationOutput,
	);
</script>

{#if latestRun?.status === 'failed'}
	<TextPreviewDialog
		{id}
		title="Transformation Error"
		label="transformation error"
		text={latestRun.error}
	/>
{:else if latestRun?.status === 'completed'}
	<TextPreviewDialog
		{id}
		title="Transformation Output"
		label="transformation output"
		text={latestRun.output}
	/>
{/if}
