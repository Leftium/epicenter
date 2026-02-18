<script lang="ts">
	import { VList } from 'virtua/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { cn } from '@epicenter/ui/utils';
	import { browserState } from '$lib/state/browser-state.svelte';
	import type { WindowCompositeId } from '$lib/device/composite-id';
	import TabItem from './TabItem.svelte';
	import * as Empty from '@epicenter/ui/empty';
	import { Badge } from '@epicenter/ui/badge';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import AppWindowIcon from '@lucide/svelte/icons/app-window';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

	// Track which windows are expanded — seed with focused window.
	// Safe to read browserState.windows here because App.svelte gates
	// rendering on browserState.whenReady (data is already loaded).
	const expandedWindows = new SvelteSet<WindowCompositeId>(
		browserState.windows.filter((w) => w.focused).map((w) => w.id),
	);

	function toggleWindow(id: WindowCompositeId) {
		if (expandedWindows.has(id)) expandedWindows.delete(id);
		else expandedWindows.add(id);
	}

	// Flatten windows and tabs, respecting collapsed state
	const flatItems = $derived(
		browserState.windows.flatMap((window) => {
			const header = { kind: 'window' as const, window };
			if (!expandedWindows.has(window.id)) return [header];
			const tabs = browserState.tabsByWindow(window.id);
			return [header, ...tabs.map((tab) => ({ kind: 'tab' as const, tab }))];
		}),
	);
</script>

{#if browserState.windows.length === 0}
	<Empty.Root class="py-8">
		<Empty.Media>
			<FolderOpenIcon class="size-8 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>No tabs found</Empty.Title>
		<Empty.Description>Open some tabs to see them here</Empty.Description>
	</Empty.Root>
{:else}
	<VList
		data={flatItems}
		style="height: 100%;"
		getKey={(item) =>
			item.kind === 'window'
				? `window-${item.window.id}`
				: `tab-${item.tab.id}`}
	>
		{#snippet children(item)}
			{#if item.kind === 'window'}
				{@const windowTabs = browserState.tabsByWindow(item.window.id)}
				{@const activeTab = windowTabs.find((t) => t.active)}
				{@const firstTab = windowTabs.at(0)}
				{@const isExpanded = expandedWindows.has(item.window.id)}
				<button
					type="button"
					onclick={() => toggleWindow(item.window.id)}
					class="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-2 border-b bg-muted/50 px-4 py-2 text-sm text-muted-foreground backdrop-blur transition hover:bg-muted/80"
				>
					<ChevronRightIcon
						class={cn('size-4 shrink-0 transition', isExpanded && 'rotate-90')}
					/>
					<AppWindowIcon class="size-4 shrink-0" />
					<span class="truncate">
						{(activeTab ?? firstTab)?.title ?? 'Window'}
					</span>
					{#if item.window.focused}
						<Badge variant="secondary" class="ml-auto shrink-0">focused</Badge>
					{/if}
					<Badge variant="outline" class="shrink-0">
						{windowTabs.length}
					</Badge>
				</button>
			{:else}
				<div class="border-b border-border">
					<TabItem tab={item.tab} />
				</div>
			{/if}
		{/snippet}
	</VList>
{/if}
