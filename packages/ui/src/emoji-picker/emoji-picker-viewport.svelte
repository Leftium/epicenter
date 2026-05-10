<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '../utils.js';

	let {
		class: className,
		children,
		...rest
	}: HTMLAttributes<HTMLDivElement> = $props();
</script>

<div {...rest} class={cn('border-border rounded-md border', className)}>
	{@render children?.()}
</div>
