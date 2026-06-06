<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>> = $props();
</script>

<main
	bind:this={ref}
	data-slot="sidebar-inset"
	class={cn(
		'cn-sidebar-inset relative flex w-full flex-1 flex-col',
		// Custom: keep Epicenter min-w-0 override (allows flex child shrink).
		'min-w-0',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</main>
