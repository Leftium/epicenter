<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	import { cn, type WithElementRef, type WithoutChildren } from '../utils.js';

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		'data-slot': dataSlot = 'textarea',
		...restProps
	}: WithoutChildren<WithElementRef<HTMLTextareaAttributes>> = $props();

	// Detached inputs keep their native listeners. Retire both reads and writes.
	let live = true;
	let shown: typeof value;
	onDestroy(() => {
		live = false;
	});
	function readValue() {
		if (live) shown = value;
		return shown;
	}
	function writeValue(next: typeof value) {
		if (live) value = next;
	}
</script>

<textarea
	bind:this={ref}
	data-slot={dataSlot}
	class={cn(
		'border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 rounded-md border bg-transparent px-2.5 py-2 text-base shadow-xs transition-[color,box-shadow] focus-visible:ring-3 aria-invalid:ring-3 md:text-sm placeholder:text-muted-foreground flex field-sizing-content min-h-16 w-full outline-none disabled:cursor-not-allowed disabled:opacity-50',
		className,
	)}
	bind:value={readValue, writeValue}
	{...restProps}
></textarea>
