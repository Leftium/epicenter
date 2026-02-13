<script lang="ts">
	import { Ok, trySync } from 'wellcrafted/result';
	import { browserState } from '$lib/browser-state.svelte';
	import { suspendedTabState } from '$lib/suspended-tab-state.svelte';
	import XIcon from '@lucide/svelte/icons/x';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import Volume2Icon from '@lucide/svelte/icons/volume-2';
	import VolumeXIcon from '@lucide/svelte/icons/volume-x';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import { Button } from '@epicenter/ui/button';
	import * as Avatar from '@epicenter/ui/avatar';
	import { cn } from '@epicenter/ui/utils';
	import type { Tab } from '$lib/epicenter';

	let { tab }: { tab: Tab } = $props();

	// Use tabId for browser API calls (native browser tab ID)
	const tabId = $derived(tab.tabId);

	// Extract domain from URL for display
	const domain = $derived.by(() => {
		const url = tab.url;
		if (!url) return '';
		const { data } = trySync({
			try: () => new URL(url).hostname,
			catch: () => Ok(url),
		});
		return data;
	});
</script>

<button
	type="button"
	class={cn(
		'group flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent',
		tab.active && 'bg-accent/50',
	)}
	onclick={() => browserState.actions.activate(tabId)}
>
	<!-- Favicon -->
	<Avatar.Root class="size-4 shrink-0 rounded-sm">
		<Avatar.Image src={tab.favIconUrl} alt="" />
		<Avatar.Fallback class="rounded-sm">
			<GlobeIcon class="size-3 text-muted-foreground" />
		</Avatar.Fallback>
	</Avatar.Root>

	<!-- Title and URL -->
	<div class="min-w-0 flex-1">
		<div class="flex items-center gap-1">
			{#if tab.pinned}
				<PinIcon class="size-3 shrink-0 text-muted-foreground" />
			{/if}
			{#if tab.audible && !tab.mutedInfo?.muted}
				<Volume2Icon class="size-3 shrink-0 text-muted-foreground" />
			{/if}
			{#if tab.mutedInfo?.muted}
				<VolumeXIcon class="size-3 shrink-0 text-muted-foreground" />
			{/if}
			<span class="truncate text-sm font-medium">
				{tab.title || 'Untitled'}
			</span>
		</div>
		<div class="truncate text-xs text-muted-foreground">
			{domain}
		</div>
	</div>

	<!-- Actions (visible on hover) -->
	<div
		class="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
	>
		<Button
			variant="ghost"
			size="icon-xs"
			tooltip={tab.pinned ? 'Unpin' : 'Pin'}
			onclick={(e: MouseEvent) => {
				e.stopPropagation();
				if (tab.pinned) {
					browserState.actions.unpin(tabId);
				} else {
					browserState.actions.pin(tabId);
				}
			}}
		>
			{#if tab.pinned}
				<PinOffIcon />
			{:else}
				<PinIcon />
			{/if}
		</Button>

		{#if tab.audible || tab.mutedInfo?.muted}
			<Button
				variant="ghost"
				size="icon-xs"
				tooltip={tab.mutedInfo?.muted ? 'Unmute' : 'Mute'}
				onclick={(e: MouseEvent) => {
					e.stopPropagation();
					if (tab.mutedInfo?.muted) {
						browserState.actions.unmute(tabId);
					} else {
						browserState.actions.mute(tabId);
					}
				}}
			>
				{#if tab.mutedInfo?.muted}
					<Volume2Icon />
				{:else}
					<VolumeXIcon />
				{/if}
			</Button>
		{/if}

		<Button
			variant="ghost"
			size="icon-xs"
			tooltip="Reload"
			onclick={(e: MouseEvent) => {
				e.stopPropagation();
				browserState.actions.reload(tabId);
			}}
		>
			<RefreshCwIcon />
		</Button>

		<Button
			variant="ghost"
			size="icon-xs"
			tooltip="Duplicate"
			onclick={(e: MouseEvent) => {
				e.stopPropagation();
				browserState.actions.duplicate(tabId);
			}}
		>
			<CopyIcon />
		</Button>

		<Button
			variant="ghost"
			size="icon-xs"
			tooltip="Suspend"
			onclick={(e: MouseEvent) => {
				e.stopPropagation();
				suspendedTabState.actions.suspend(tab);
			}}
		>
			<PauseIcon />
		</Button>

		<Button
			variant="ghost"
			size="icon-xs"
			class="text-destructive hover:text-destructive"
			tooltip="Close"
			onclick={(e: MouseEvent) => {
				e.stopPropagation();
				browserState.actions.close(tabId);
			}}
		>
			<XIcon />
		</Button>
	</div>
</button>
