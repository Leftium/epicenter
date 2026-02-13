<script lang="ts">
	import { suspendedTabState } from '$lib/suspended-tab-state.svelte';
	import { Button } from '@epicenter/ui/button';
	import * as Avatar from '@epicenter/ui/avatar';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import { Ok, trySync } from 'wellcrafted/result';

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
			{#if suspendedTabState.tabs.length}
				<span
					class="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground"
				>
					{suspendedTabState.tabs.length}
				</span>
			{/if}
		</h2>
	</header>

	{#if !suspendedTabState.tabs.length}
		<div
			class="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-8 text-center text-muted-foreground"
		>
			<PauseIcon class="size-8 opacity-50" />
			<p class="text-sm font-medium">No suspended tabs</p>
			<p class="text-xs">Suspend tabs to save them for later</p>
		</div>
	{:else}
		<div class="flex flex-col gap-1">
			{#each suspendedTabState.tabs as tab (tab.id)}
				<div
					class="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/50"
				>
					<Avatar.Root class="size-4 shrink-0 rounded-sm">
						<Avatar.Image src={tab.favIconUrl} alt="" />
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
							<span class="shrink-0">{getRelativeTime(tab.suspendedAt)}</span>
						</div>
					</div>

					<div
						class="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
					>
						<Button
							variant="ghost"
							size="icon-xs"
							tooltip="Restore"
							onclick={() => suspendedTabState.actions.restore(tab)}
						>
							<RotateCcwIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-xs"
							class="text-destructive hover:text-destructive"
							tooltip="Delete"
							onclick={() => suspendedTabState.actions.remove(tab.id)}
						>
							<Trash2Icon />
						</Button>
					</div>
				</div>
			{/each}
		</div>

		<div class="mt-2 flex justify-end gap-2 border-t pt-2">
			<Button
				variant="outline"
				size="sm"
				onclick={() => suspendedTabState.actions.restoreAll()}
			>
				Restore All
			</Button>
			<Button
				variant="destructive"
				size="sm"
				onclick={() => suspendedTabState.actions.removeAll()}
			>
				Delete All
			</Button>
		</div>
	{/if}
</section>
