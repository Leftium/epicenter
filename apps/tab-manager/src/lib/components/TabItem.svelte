<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import { Ok, trySync } from 'wellcrafted/result';
	import { rpc, queryClient } from '$lib/query';
	import { suspendedTabs, suspendedTabsKeys } from '$lib/query/suspended-tabs';
	import { tabsKeys } from '$lib/query/tabs';
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
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Avatar from '@epicenter/ui/avatar';
	import { cn } from '@epicenter/ui/utils';
	import type { Tab } from '$lib/epicenter';

	let { tab }: { tab: Tab } = $props();

	// Use tabId for browser API calls (native browser tab ID)
	const tabId = $derived(tab.tabId);

	const closeMutation = createMutation(() => rpc.tabs.close.options);
	const activateMutation = createMutation(() => rpc.tabs.activate.options);
	const pinMutation = createMutation(() => rpc.tabs.pin.options);
	const unpinMutation = createMutation(() => rpc.tabs.unpin.options);
	const muteMutation = createMutation(() => rpc.tabs.mute.options);
	const unmuteMutation = createMutation(() => rpc.tabs.unmute.options);
	const reloadMutation = createMutation(() => rpc.tabs.reload.options);
	const duplicateMutation = createMutation(() => rpc.tabs.duplicate.options);

	const suspendMutation = createMutation(() => ({
		...suspendedTabs.suspend.options,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: suspendedTabsKeys.all });
			queryClient.invalidateQueries({ queryKey: tabsKeys.all });
		},
	}));

	const isPinPending = $derived(
		pinMutation.isPending || unpinMutation.isPending,
	);
	const isMutePending = $derived(
		muteMutation.isPending || unmuteMutation.isPending,
	);

	// Extract domain from URL for display
	const domain = $derived.by(() => {
		if (!tab.url) return '';
		const { data } = trySync({
			try: () => new URL(tab.url).hostname,
			catch: () => Ok(tab.url),
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
	onclick={() => activateMutation.mutate(tabId)}
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
			{#if tab.audible && !tab.muted}
				<Volume2Icon class="size-3 shrink-0 text-muted-foreground" />
			{/if}
			{#if tab.muted}
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
			disabled={isPinPending}
			tooltip={tab.pinned ? 'Unpin' : 'Pin'}
			onclick={(e: MouseEvent) => {
				e.stopPropagation();
				if (tab.pinned) {
					unpinMutation.mutate(tabId);
				} else {
					pinMutation.mutate(tabId);
				}
			}}
		>
			{#if isPinPending}
				<Spinner />
			{:else if tab.pinned}
				<PinOffIcon />
			{:else}
				<PinIcon />
			{/if}
		</Button>

		{#if tab.audible || tab.muted}
			<Button
				variant="ghost"
				size="icon-xs"
				disabled={isMutePending}
				tooltip={tab.muted ? 'Unmute' : 'Mute'}
				onclick={(e: MouseEvent) => {
					e.stopPropagation();
					if (tab.muted) {
						unmuteMutation.mutate(tabId);
					} else {
						muteMutation.mutate(tabId);
					}
				}}
			>
				{#if isMutePending}
					<Spinner />
				{:else if tab.muted}
					<Volume2Icon />
				{:else}
					<VolumeXIcon />
				{/if}
			</Button>
		{/if}

		<Button
			variant="ghost"
			size="icon-xs"
			disabled={reloadMutation.isPending}
			tooltip="Reload"
			onclick={(e: MouseEvent) => {
				e.stopPropagation();
				reloadMutation.mutate(tabId);
			}}
		>
			{#if reloadMutation.isPending}
				<Spinner />
			{:else}
				<RefreshCwIcon />
			{/if}
		</Button>

		<Button
			variant="ghost"
			size="icon-xs"
			disabled={duplicateMutation.isPending}
			tooltip="Duplicate"
			onclick={(e: MouseEvent) => {
				e.stopPropagation();
				duplicateMutation.mutate(tabId);
			}}
		>
			{#if duplicateMutation.isPending}
				<Spinner />
			{:else}
				<CopyIcon />
			{/if}
		</Button>

		<Button
			variant="ghost"
			size="icon-xs"
			disabled={suspendMutation.isPending}
			tooltip="Suspend"
			onclick={(e: MouseEvent) => {
				e.stopPropagation();
				suspendMutation.mutate(tab);
			}}
		>
			{#if suspendMutation.isPending}
				<Spinner />
			{:else}
				<PauseIcon />
			{/if}
		</Button>

		<Button
			variant="ghost"
			size="icon-xs"
			class="text-destructive hover:text-destructive"
			disabled={closeMutation.isPending}
			tooltip="Close"
			onclick={(e: MouseEvent) => {
				e.stopPropagation();
				closeMutation.mutate(tabId);
			}}
		>
			{#if closeMutation.isPending}
				<Spinner />
			{:else}
				<XIcon />
			{/if}
		</Button>
	</div>
</button>
