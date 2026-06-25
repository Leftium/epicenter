<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Modal from '@epicenter/ui/modal';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import type { ComponentProps } from 'svelte';
	import { Runs } from '$lib/components/transformations-editor';
	import { transformationRuns } from '$lib/state/transformation-runs.svelte';

	/**
	 * Opens the full transformation-run history for a recording. Lives in the
	 * recording detail modal toolbar; the compact row no longer carries it.
	 */
	let {
		recordingId,
		variant = 'ghost',
		size = 'icon',
		showLabel = false,
	}: {
		recordingId: string;
		variant?: ComponentProps<typeof Button>['variant'];
		size?: ComponentProps<typeof Button>['size'];
		/** Render the action's text beside the icon (detail modal toolbar). */
		showLabel?: boolean;
	} = $props();

	const runs = $derived(transformationRuns.getByRecordingId(recordingId));

	let isOpen = $state(false);
</script>

<Modal.Root bind:open={isOpen}>
	<Modal.Trigger>
		{#snippet child({ props })}
			<Button {...props} {variant} {size} tooltip="View transformation runs">
				<HistoryIcon class="size-4" />
				{#if showLabel}Runs{/if}
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
		<div class="max-h-[60vh] overflow-y-auto"><Runs {runs} /></div>
		<Modal.Footer>
			<Button variant="outline" onclick={() => (isOpen = false)}>Close</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
