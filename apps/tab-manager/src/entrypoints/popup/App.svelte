<script lang="ts">
	import TabList from '$lib/components/TabList.svelte';
	import SavedTabList from '$lib/components/SavedTabList.svelte';
	import { browserState } from '$lib/state/browser-state.svelte';
	import { savedTabState } from '$lib/state/saved-tab-state.svelte';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import { Badge } from '@epicenter/ui/badge';
	import * as Tabs from '@epicenter/ui/tabs';
	import * as Tooltip from '@epicenter/ui/tooltip';

	const totalTabs = $derived(
		browserState.windows.reduce(
			(sum, w) => sum + browserState.tabsByWindow(w.id).length,
			0,
		),
	);
</script>

<Tooltip.Provider>
	<main
		class="w-[800px] min-h-[600px] max-h-[600px] overflow-hidden bg-background text-foreground"
	>
		<Tabs.Root value="windows" class="flex h-full flex-col">
			<header
				class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60 px-3 pt-3 pb-0"
			>
				<h1 class="px-1 text-lg font-semibold">Tab Manager</h1>
				<Tabs.List class="mt-2 w-full">
					<Tabs.Trigger value="windows" class="flex-1 gap-1.5">
						Tabs
						<Badge variant="outline" class="ml-0.5">{totalTabs}</Badge>
					</Tabs.Trigger>
					<Tabs.Trigger value="saved" class="flex-1 gap-1.5">
						Saved
						{#if savedTabState.tabs.length}
							<Badge variant="outline" class="ml-0.5">
								{savedTabState.tabs.length}
							</Badge>
						{/if}
					</Tabs.Trigger>
				</Tabs.List>
			</header>
			<ScrollArea class="flex-1">
				<Tabs.Content value="windows">
					<TabList />
				</Tabs.Content>
				<Tabs.Content value="saved">
					<SavedTabList />
				</Tabs.Content>
			</ScrollArea>
		</Tabs.Root>
	</main>
</Tooltip.Provider>
