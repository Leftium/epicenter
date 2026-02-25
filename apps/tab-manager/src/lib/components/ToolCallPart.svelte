<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import CollapsibleSection from './CollapsibleSection.svelte';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import type { ToolCallPart as TanStackToolCallPart } from '@tanstack/ai-client';
	import type { PopupActionName } from '$lib/workspace-popup';

	let {
		part,
	}: {
		part: TanStackToolCallPart;
	} = $props();

	const toolLabels: Record<PopupActionName, { active: string; done: string }> =
		{
			tabs_search: { active: 'Searching tabs', done: 'Searched tabs' },
			tabs_list: { active: 'Listing tabs', done: 'Listed tabs' },
			windows_list: { active: 'Listing windows', done: 'Listed windows' },
			devices_list: { active: 'Listing devices', done: 'Listed devices' },
			domains_count: {
				active: 'Counting domains',
				done: 'Counted domains',
			},
			tabs_close: { active: 'Closing tabs', done: 'Closed tabs' },
			tabs_open: { active: 'Opening tab', done: 'Opened tab' },
			tabs_activate: { active: 'Activating tab', done: 'Activated tab' },
			tabs_save: { active: 'Saving tabs', done: 'Saved tabs' },
			tabs_group: { active: 'Grouping tabs', done: 'Grouped tabs' },
			tabs_pin: { active: 'Pinning tabs', done: 'Pinned tabs' },
			tabs_mute: { active: 'Muting tabs', done: 'Muted tabs' },
			tabs_reload: { active: 'Reloading tabs', done: 'Reloaded tabs' },
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
		const labels = toolLabels[part.name as PopupActionName] as
			| { active: string; done: string }
			| undefined;
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
	<pre
		class="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px]">{text}</pre>
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
				{@render codeBlock(
					typeof part.output === 'string'
						? part.output
						: JSON.stringify(part.output, null, 2),
				)}
			</div>
		{/if}
	</CollapsibleSection>
</div>
