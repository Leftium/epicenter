<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { Separator } from '#ui/separator';
	import { cn } from '#utils';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: ComponentProps<typeof Separator> = $props();
</script>

<Separator
	bind:ref
	data-slot="item-separator"
	orientation="horizontal"
	class={cn('my-0', className)}
	{...restProps}
/>
