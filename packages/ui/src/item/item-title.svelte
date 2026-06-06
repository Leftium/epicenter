<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="item-title"
	class={cn(
		'cn-item-title flex items-center',
		// Custom override: upstream uses `w-fit` here. We use `min-w-0` instead
		// to enable text truncation inside flex containers.
		'min-w-0',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
