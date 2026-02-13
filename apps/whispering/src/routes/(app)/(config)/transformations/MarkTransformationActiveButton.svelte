<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import type { Transformation } from '$lib/services/isomorphic/db';
	import { settings } from '$lib/state/settings.svelte';
	import CheckCircleIcon from '@lucide/svelte/icons/check-circle';
	import CircleIcon from '@lucide/svelte/icons/circle';

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
		settings.value['transformations.selectedTransformationId'] ===
			transformation.id,
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
			settings.updateKey('transformations.selectedTransformationId', null);
		} else {
			settings.updateKey(
				'transformations.selectedTransformationId',
				transformation.id,
			);
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
