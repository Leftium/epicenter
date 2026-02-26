<script lang="ts">
	import * as Collapsible from '@epicenter/ui/collapsible';
	import { cn } from '@epicenter/ui/utils';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import type { Snippet } from 'svelte';

	let {
		label,
		icon,
		children,
		contentClass,
	}: {
		label: string;
		icon?: Snippet;
		children: Snippet;
		contentClass?: string;
	} = $props();
</script>

<Collapsible.Root>
	<Collapsible.Trigger
		class="flex items-center gap-1 py-1 text-xs text-muted-foreground hover:text-foreground"
	>
		<ChevronRightIcon
			class="size-3 transition-transform [[data-state=open]>&]:rotate-90"
		/>
		{#if icon}
			{@render icon()}
		{/if}
		{label}
	</Collapsible.Trigger>
	<Collapsible.Content>
		<div
			class={cn(
				'mt-1 rounded-md p-2 text-xs',
				contentClass ?? 'bg-muted/30 text-muted-foreground',
			)}
		>
			{@render children()}
		</div>
	</Collapsible.Content>
</Collapsible.Root>
