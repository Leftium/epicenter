<script lang="ts">
	import { Runs } from '$lib/components/transformations-editor';
	import { Button } from '@epicenter/ui/button';
	import * as Modal from '@epicenter/ui/modal';
	import { rpc } from '$lib/query';
	import { createQuery } from '@tanstack/svelte-query';
	import HistoryIcon from '@lucide/svelte/icons/history';

	let { recordingId }: { recordingId: string } = $props();

	const transformationRunsByRecordingIdQuery = createQuery(
		() => rpc.db.runs.getByRecordingId(() => recordingId).options,
	);

	let isOpen = $state(false);
</script>

<Modal.Root bind:open={isOpen}>
	<Modal.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon"
				tooltip="View Transformation Runs"
			>
				<HistoryIcon class="size-4" />
			</Button>
		{/snippet}
	</Modal.Trigger>
	<Modal.Content class="sm:max-w-4xl">
		<Modal.Header>
			<Modal.Title>Transformation Runs</Modal.Title>
			<Modal.Description>
				View all transformation runs for this recording
			</Modal.Description>
		</Modal.Header>
		<div class="max-h-[60vh] overflow-y-auto">
			{#if transformationRunsByRecordingIdQuery.isPending}
				<div class="text-muted-foreground text-sm">Loading runs...</div>
			{:else if transformationRunsByRecordingIdQuery.error}
				<div class="text-destructive text-sm">
					{transformationRunsByRecordingIdQuery.error.message}
				</div>
			{:else if transformationRunsByRecordingIdQuery.data}
				<Runs runs={transformationRunsByRecordingIdQuery.data} />
			{/if}
		</div>
		<Modal.Footer>
			<Button variant="outline" onclick={() => (isOpen = false)}>Close</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
