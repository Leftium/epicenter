<script lang="ts">
	import { VList } from 'virtua/svelte';
	import { browserState } from '$lib/state/browser-state.svelte';
	import TabItem from './TabItem.svelte';
	import * as Empty from '@epicenter/ui/empty';
	import { Badge } from '@epicenter/ui/badge';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import AppWindowIcon from '@lucide/svelte/icons/app-window';

	// Flatten windows and tabs into a single list for virtualization
	const flatItems = $derived(
		browserState.windows.flatMap((window) => {
			const tabs = browserState.tabsByWindow(window.id);
			return [
				{ kind: 'window' as const, window },
				...tabs.map((tab) => ({ kind: 'tab' as const, tab })),
			];
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
				{@const firstTab = windowTabs[0]}
				{@const displayTab = activeTab || firstTab}
				<div
					class="sticky top-0 z-10 flex items-center gap-2 bg-muted/50 px-4 py-2 text-xs backdrop-blur border-b"
				>
					<AppWindowIcon class="size-3 text-muted-foreground shrink-0" />
					<span class="truncate text-muted-foreground">
						{#if displayTab?.title}
							{displayTab.title}
						{:else}
							Window
						{/if}
					</span>
					{#if item.window.focused}
						<Badge variant="secondary" class="ml-auto shrink-0">focused</Badge>
					{/if}
					<Badge variant="outline" class="shrink-0">
						{windowTabs.length}
					</Badge>
				</div>
			{:else}
				<div class="border-b border-border">
					<TabItem tab={item.tab} />
				</div>
			{/if}
		{/snippet}
	</VList>
{/if}
