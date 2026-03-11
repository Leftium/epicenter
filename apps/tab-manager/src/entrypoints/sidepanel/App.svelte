<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import * as Tabs from '@epicenter/ui/tabs';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import AiChat from '$lib/components/chat/AiChat.svelte';
	import SyncStatusIndicator from '$lib/components/SyncStatusIndicator.svelte';
	import FlatTabList from '$lib/components/tabs/FlatTabList.svelte';
	import SavedTabList from '$lib/components/tabs/SavedTabList.svelte';
	import { browserState } from '$lib/state/browser-state.svelte';
	import { savedTabState } from '$lib/state/saved-tab-state.svelte';

	const totalTabs = $derived(
		browserState.windows.reduce(
			(sum, w) => sum + browserState.tabsByWindow(w.id).length,
			0,
		),
	);
</script>

<AuthGate>
	<Tooltip.Provider>
		<main
			class="h-full w-full overflow-hidden flex flex-col bg-background text-foreground"
		>
			<Tabs.Root value="windows" class="flex flex-col h-full">
				<header
					class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60 px-3 pt-3 pb-0"
				>
					<div class="flex items-center justify-between px-1">
						<h1 class="text-lg font-semibold">Tab Manager</h1>
						<SyncStatusIndicator />
					</div>
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
						<Tabs.Trigger value="ai" class="flex-1 gap-1.5">
							<SparklesIcon class="size-3.5" />
							AI
						</Tabs.Trigger>
					</Tabs.List>
				</header>
				<!-- Gate on browser state seed so child components can read data synchronously -->
				{#await browserState.whenReady}
					<div class="flex-1 flex items-center justify-center">
						<p class="text-sm text-muted-foreground">Loading tabs…</p>
					</div>
				{:then _}
					<Tabs.Content value="windows" class="flex-1 min-h-0 mt-0">
						<FlatTabList />
					</Tabs.Content>
					<Tabs.Content value="saved" class="flex-1 min-h-0 mt-0">
						<SavedTabList />
					</Tabs.Content>
				{/await}
				<Tabs.Content value="ai" class="flex-1 min-h-0 mt-0">
					<AiChat />
				</Tabs.Content>
			</Tabs.Root>
		</main>
	</Tooltip.Provider>
</AuthGate>
<ConfirmationDialog />
