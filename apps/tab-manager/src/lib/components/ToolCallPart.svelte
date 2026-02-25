<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import CollapsibleSection from './CollapsibleSection.svelte';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import type { ToolCallPart as TanStackToolCallPart } from '@tanstack/ai-client';
	import type { ToolName } from '$lib/ai/tools/definitions';

	let {
		part,
	}: {
		part: TanStackToolCallPart;
	} = $props();

	const toolLabels: Record<ToolName, { active: string; done: string }> = {
		searchTabs: { active: 'Searching tabs', done: 'Searched tabs' },
		listTabs: { active: 'Listing tabs', done: 'Listed tabs' },
		listWindows: { active: 'Listing windows', done: 'Listed windows' },
		listDevices: { active: 'Listing devices', done: 'Listed devices' },
		countByDomain: { active: 'Counting domains', done: 'Counted domains' },
		closeTabs: { active: 'Closing tabs', done: 'Closed tabs' },
		openTab: { active: 'Opening tab', done: 'Opened tab' },
		activateTab: { active: 'Activating tab', done: 'Activated tab' },
		saveTabs: { active: 'Saving tabs', done: 'Saved tabs' },
		groupTabs: { active: 'Grouping tabs', done: 'Grouped tabs' },
		pinTabs: { active: 'Pinning tabs', done: 'Pinned tabs' },
		muteTabs: { active: 'Muting tabs', done: 'Muted tabs' },
		reloadTabs: { active: 'Reloading tabs', done: 'Reloaded tabs' },
	};

	const hasOutput = $derived(part.output != null);
	const isRunning = $derived(
		!hasOutput &&
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
	const displayName = $derived.by(() => {
		const labels = toolLabels[part.name as ToolName];
		if (!labels) return part.name;
		return isRunning ? labels.active : labels.done;
	});
	const badgeVariant = $derived(
		isFailed
			? ('status.failed' as const)
			: isRunning
				? ('status.running' as const)
				: ('status.completed' as const),
	);
</script>

{#snippet codeBlock(text: string)}
	<pre class="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px]">{text}</pre>
{/snippet}

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

	<CollapsibleSection label="Details" contentClass="bg-muted/50">
		{#if part.arguments}
			<div class="mb-1">
				<span class="font-medium text-muted-foreground">Arguments:</span>
				{@render codeBlock(part.arguments)}
			</div>
		{/if}
		{#if part.output != null}
			<div>
				<span class="font-medium text-muted-foreground">Result:</span>
				{@render codeBlock(typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 2))}
			</div>
		{/if}
	</CollapsibleSection>
</div>
