<script lang="ts">
	import { cn, type WithElementRef } from '#/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		showOnHover = false,
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		/** When true, actions are hidden by default and shown on hover of the parent `group/item`. */
		showOnHover?: boolean;
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="item-actions"
	class={cn(
		'flex items-center gap-2',
		showOnHover && 'opacity-0 transition-opacity group-hover/item:opacity-100',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
