<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLTableRowElement>> = $props();
</script>

<tr
	bind:this={ref}
	data-slot="table-row"
	class={cn(
		'cn-table-row',
		'hover:[&,&>svelte-css-wrapper]:[&>th,td]:bg-muted/50',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</tr>
