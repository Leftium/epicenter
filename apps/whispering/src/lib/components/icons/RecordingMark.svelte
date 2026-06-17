<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import markSvg from '$lib/assets/recording-mark.svg?raw';

	let { class: className }: { class?: string } = $props();
</script>

<span class={cn('inline-flex', className)}>
	{@html markSvg}
</span>

<style>
	span :global(svg) {
		width: 100%;
		height: 100%;
	}
</style>
