<script lang="ts">
	import { rpc } from '$lib/query';
	import { createQuery } from '@tanstack/svelte-query';
	import TabItem from './TabItem.svelte';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import * as Alert from '@epicenter/ui/alert';
	import * as Empty from '@epicenter/ui/empty';
	import * as Accordion from '@epicenter/ui/accordion';
	import { Badge } from '@epicenter/ui/badge';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import AppWindowIcon from '@lucide/svelte/icons/app-window';
	import type { Tab } from '$lib/epicenter';

	// Get all tabs and windows from Y.Doc
	const tabsQuery = createQuery(() => rpc.tabs.getAll.options);
	const windowsQuery = createQuery(() => rpc.tabs.getAllWindows.options);

	// Group tabs by window
	const tabsByWindow = $derived.by(() => {
		if (!tabsQuery.data || !windowsQuery.data) return new Map<string, Tab[]>();

		const grouped = new Map<string, Tab[]>();
		for (const window of windowsQuery.data) {
			const windowTabs = tabsQuery.data.filter((t) => t.windowId === window.id);
			// Already sorted by index from query
			grouped.set(window.id, windowTabs);
		}
		return grouped;
	});

	// Default all windows to open
	const defaultOpenWindows = $derived(
		(windowsQuery.data ?? []).map((w) => w.id),
	);
</script>

<div class="flex flex-col">
	{#if tabsQuery.error || windowsQuery.error}
		<!-- Error state -->
		<div class="p-4">
			<Alert.Root variant="destructive">
				<AlertCircleIcon />
				<Alert.Title>Error loading tabs</Alert.Title>
				<Alert.Description>
					{tabsQuery.error?.message ?? windowsQuery.error?.message}
				</Alert.Description>
			</Alert.Root>
		</div>
	{:else if tabsQuery.isPending || windowsQuery.isPending}
		<!-- Loading state -->
		<div class="flex flex-col gap-1 p-2">
			{#each { length: 5 } as _}
				<div class="flex items-center gap-3 px-4 py-2">
					<Skeleton class="size-4 rounded-sm" />
					<div class="flex-1 space-y-1">
						<Skeleton class="h-4 w-3/4" />
						<Skeleton class="h-3 w-1/2" />
					</div>
				</div>
			{/each}
		</div>
	{:else if tabsQuery.data && windowsQuery.data}
		<!-- Data state -->
		{@const windows = windowsQuery.data}
		{#if windows.length === 0}
			<Empty.Root class="py-8">
				<Empty.Media>
					<FolderOpenIcon class="size-8 text-muted-foreground" />
				</Empty.Media>
				<Empty.Title>No tabs found</Empty.Title>
				<Empty.Description>Open some tabs to see them here</Empty.Description>
			</Empty.Root>
		{:else}
			<Accordion.Root type="multiple" value={defaultOpenWindows} class="px-2">
				{#each windows as window (window.id)}
					{@const windowTabs = tabsByWindow.get(window.id) ?? []}
					<Accordion.Item value={window.id}>
						<Accordion.Trigger class="px-2 py-2 hover:no-underline">
							<div class="flex items-center gap-2">
								<AppWindowIcon class="size-4 text-muted-foreground" />
								<span class="text-sm font-medium">
									Window
									{#if window.focused}
										<Badge variant="secondary" class="ml-1">focused</Badge>
									{/if}
								</span>
								<Badge variant="outline" class="ml-auto">
									{windowTabs.length}
								</Badge>
							</div>
						</Accordion.Trigger>
						<Accordion.Content class="pb-0 divide-y">
							{#each windowTabs as tab (tab.id)}
								<TabItem {tab} />
							{/each}
						</Accordion.Content>
					</Accordion.Item>
				{/each}
			</Accordion.Root>
		{/if}
	{/if}
</div>
