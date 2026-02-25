<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import type { ToolCallPart as TanStackToolCallPart } from '@tanstack/ai-client';

	let {
		part,
	}: {
		part: TanStackToolCallPart;
	} = $props();

	const toolDisplayNames: Record<string, string> = {
		searchTabs: 'Searching tabs',
		listTabs: 'Listing tabs',
		listWindows: 'Listing windows',
		listDevices: 'Listing devices',
		countByDomain: 'Counting domains',
		closeTabs: 'Closing tabs',
		openTab: 'Opening tab',
		activateTab: 'Activating tab',
		saveTabs: 'Saving tabs',
		groupTabs: 'Grouping tabs',
		pinTabs: 'Pinning tabs',
		muteTabs: 'Muting tabs',
		reloadTabs: 'Reloading tabs',
	};

	const displayName = $derived(toolDisplayNames[part.name] ?? part.name);
	const isRunning = $derived(
		['awaiting-input', 'input-streaming', 'input-complete'].includes(
			part.state,
		),
	);
	const isFailed = $derived(
		part.output &&
			typeof part.output === 'object' &&
			part.output !== null &&
			'error' in part.output,
	);
	const badgeVariant = $derived(
		isFailed
			? ('status.failed' as const)
			: isRunning
				? ('status.running' as const)
				: ('status.completed' as const),
	);
</script>

<div class="flex flex-col gap-1 py-1">
	<div class="flex items-center gap-1.5">
		{#if isRunning}
			<LoaderCircleIcon class="size-3 animate-spin text-blue-500" />
		{:else}
			<WrenchIcon class="size-3 text-muted-foreground" />
		{/if}
		<Badge variant={badgeVariant}>
			{displayName}{isRunning ? '…' : ''}
		</Badge>
	</div>

	<Collapsible.Root>
		<Collapsible.Trigger
			class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
		>
			<ChevronRightIcon
				class="size-3 transition-transform [[data-state=open]>&]:rotate-90"
			/>
			Details
		</Collapsible.Trigger>
		<Collapsible.Content>
			<div class="mt-1 rounded-md bg-muted/50 p-2 text-xs">
				{#if part.arguments}
					<div class="mb-1">
						<span class="font-medium text-muted-foreground"
							>Arguments:</span
						>
						<pre
							class="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px]"
							>{part.arguments}</pre
						>
					</div>
				{/if}
				{#if part.output != null}
					<div>
						<span class="font-medium text-muted-foreground"
							>Result:</span
						>
						<pre
							class="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px]"
							>{typeof part.output === 'string'
								? part.output
								: JSON.stringify(part.output, null, 2)}</pre
						>
					</div>
				{/if}
			</div>
		</Collapsible.Content>
	</Collapsible.Root>
</div>
