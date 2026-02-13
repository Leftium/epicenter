<script lang="ts">
	import { createQuery, createMutation } from '@tanstack/svelte-query';
	import { queryClient } from '$lib/query';
	import { suspendedTabs, suspendedTabsKeys } from '$lib/query/suspended-tabs';
	import { tabsKeys } from '$lib/query/tabs';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Avatar from '@epicenter/ui/avatar';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import { Ok, trySync } from 'wellcrafted/result';
	import type { SuspendedTab } from '$lib/epicenter';

	const query = createQuery(() => suspendedTabs.getAll.options);

	const restoreMutation = createMutation(() => ({
		...suspendedTabs.restore.options,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: suspendedTabsKeys.all });
			queryClient.invalidateQueries({ queryKey: tabsKeys.all });
		},
	}));

	const removeMutation = createMutation(() => ({
		...suspendedTabs.remove.options,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: suspendedTabsKeys.all });
		},
	}));

	const restoreAllMutation = createMutation(() => ({
		...suspendedTabs.restoreAll.options,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: suspendedTabsKeys.all });
			queryClient.invalidateQueries({ queryKey: tabsKeys.all });
		},
	}));

	const removeAllMutation = createMutation(() => ({
		...suspendedTabs.removeAll.options,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: suspendedTabsKeys.all });
		},
	}));

	function getRelativeTime(timestamp: number) {
		const now = Date.now();
		const diff = now - timestamp;
		const seconds = Math.floor(diff / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);

		if (days > 0) return `${days}d ago`;
		if (hours > 0) return `${hours}h ago`;
		if (minutes > 0) return `${minutes}m ago`;
		return 'Just now';
	}

	function getDomain(url: string) {
		const { data } = trySync({
			try: () => new URL(url).hostname,
			catch: () => Ok(url),
		});
		return data;
	}
</script>

<section class="flex flex-col gap-2 p-4 pt-0">
	<header class="flex items-center justify-between">
		<h2 class="text-sm font-semibold text-muted-foreground">
			Suspended Tabs
			{#if query.data?.length}
				<span
					class="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground"
				>
					{query.data.length}
				</span>
			{/if}
		</h2>
	</header>

	{#if query.isLoading}
		<div class="flex justify-center p-4">
			<Spinner />
		</div>
	{:else if query.isError}
		<div class="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
			Error loading suspended tabs
		</div>
	{:else if !query.data?.length}
		<div
			class="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-8 text-center text-muted-foreground"
		>
			<PauseIcon class="size-8 opacity-50" />
			<p class="text-sm font-medium">No suspended tabs</p>
			<p class="text-xs">Suspend tabs to save them for later</p>
		</div>
	{:else}
		<div class="flex flex-col gap-1">
			{#each query.data as tab (tab.id)}
				<div
					class="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/50"
				>
					<Avatar.Root class="size-4 shrink-0 rounded-sm">
						<Avatar.Image src={tab.fav_icon_url} alt="" />
						<Avatar.Fallback class="rounded-sm">
							<GlobeIcon class="size-3 text-muted-foreground" />
						</Avatar.Fallback>
					</Avatar.Root>

					<div class="min-w-0 flex-1">
						<div class="truncate text-sm font-medium">
							{tab.title || 'Untitled'}
						</div>
						<div class="flex items-center gap-2 text-xs text-muted-foreground">
							<span class="truncate">{getDomain(tab.url)}</span>
							<span>•</span>
							<span class="shrink-0">{getRelativeTime(tab.suspended_at)}</span>
						</div>
					</div>

					<div
						class="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
					>
						<Button
							variant="ghost"
							size="icon-xs"
							tooltip="Restore"
							disabled={restoreMutation.isPending}
							onclick={() => restoreMutation.mutate(tab)}
						>
							{#if restoreMutation.isPending}<Spinner />{:else}<RotateCcwIcon
								/>{/if}
						</Button>
						<Button
							variant="ghost"
							size="icon-xs"
							class="text-destructive hover:text-destructive"
							tooltip="Delete"
							disabled={removeMutation.isPending}
							onclick={() => removeMutation.mutate(tab.id)}
						>
							{#if removeMutation.isPending}<Spinner />{:else}<Trash2Icon
								/>{/if}
						</Button>
					</div>
				</div>
			{/each}
		</div>

		<div class="mt-2 flex justify-end gap-2 border-t pt-2">
			<Button
				variant="outline"
				size="sm"
				disabled={restoreAllMutation.isPending}
				onclick={() => restoreAllMutation.mutate()}
			>
				{#if restoreAllMutation.isPending}<Spinner class="mr-2" />{/if}
				Restore All
			</Button>
			<Button
				variant="destructive"
				size="sm"
				disabled={removeAllMutation.isPending}
				onclick={() => removeAllMutation.mutate()}
			>
				{#if removeAllMutation.isPending}<Spinner class="mr-2" />{/if}
				Delete All
			</Button>
		</div>
	{/if}
</section>
