<script lang="ts">
	import { Tabs as TabsPrimitive } from 'bits-ui';
	import { cn } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		child,
		forceMount = false,
		...restProps
	}: TabsPrimitive.ContentProps & {
		/** Keep inactive children alive when their state intentionally belongs to the panel. */
		forceMount?: boolean;
	} = $props();
</script>

<TabsPrimitive.Content
	bind:ref
	data-slot="tabs-content"
	class={cn('text-sm flex-1 outline-none', className)}
	{...restProps}
>
	{#snippet child({ props })}
		{#if forceMount || !props.hidden}
			{#if child}
				{@render child({ props })}
			{:else}
				<div {...props}>
					{@render children?.()}
				</div>
			{/if}
		{/if}
	{/snippet}
</TabsPrimitive.Content>
