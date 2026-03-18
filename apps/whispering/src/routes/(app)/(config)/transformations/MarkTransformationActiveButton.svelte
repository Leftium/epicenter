<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import CheckCircleIcon from '@lucide/svelte/icons/check-circle';
	import CircleIcon from '@lucide/svelte/icons/circle';
	import type { Transformation } from '$lib/services/db';
	import { workspaceSettings } from '$lib/state/workspace-settings.svelte';

	let {
		transformation,
		class: className,
		size = 'default',
	}: {
		transformation: Transformation;
		class?: string;
		size?: 'default' | 'icon';
	} = $props();

	const isTransformationActive = $derived(
		workspaceSettings.get('transformation.selectedId') === transformation.id,
	);

	const displayText = $derived(
		isTransformationActive
			? 'Transformation selected to run on future transcriptions'
			: 'Select this transformation to run on future transcriptions',
	);
</script>

<Button
	tooltip={displayText}
	variant="ghost"
	{size}
	class={className}
	onclick={() => {
		if (isTransformationActive) {
			workspaceSettings.set('transformation.selectedId', null);
		} else {
			workspaceSettings.set('transformation.selectedId', transformation.id);
		}
	}}
>
	{#if size === 'default'}
		{displayText}
	{/if}
	{#if isTransformationActive}
		<CheckCircleIcon class="size-4 text-green-500" />
	{:else}
		<CircleIcon class="size-4" />
	{/if}
</Button>
