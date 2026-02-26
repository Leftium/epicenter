<script lang="ts" generics="TColumn extends Column<any, any>">
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowUpDownIcon from '@lucide/svelte/icons/arrow-up-down';
	import type { Column } from '@tanstack/svelte-table';

	import { Button } from '../button/index.js';

	let { column, headerText }: { column: TColumn; headerText: string } =
		$props();
</script>

<Button
	variant="ghost"
	onclick={() => {
		column.toggleSorting();
	}}
>
	{headerText}
	{#if column.getIsSorted() === 'asc'}
		<ArrowUpIcon class="size-4" />
	{:else if column.getIsSorted() === 'desc'}
		<ArrowDownIcon class="size-4" />
	{:else}
		<ArrowUpDownIcon class="size-4" />
	{/if}
</Button>
