<script lang="ts">
	import * as ButtonGroup from '@epicenter/ui/button-group';
	import type { Snippet } from 'svelte';

	let {
		children,
	}: {
		children: Snippet;
	} = $props();
</script>

<div class="flex w-full items-center justify-between gap-3">
	<span class="text-xs font-medium text-muted-foreground/75">Pipeline</span>
	<ButtonGroup.Root
		aria-label="Capture pipeline"
		class="rounded-md bg-muted/25 p-0.5"
	>
		{@render children()}
	</ButtonGroup.Root>
</div>
