<script lang="ts">
	import { VList } from 'virtua/svelte';
	import { browserState } from '$lib/state/browser-state.svelte';
	import TabItem from './TabItem.svelte';
	import * as Empty from '@epicenter/ui/empty';
	import * as Accordion from '@epicenter/ui/accordion';
	import { Badge } from '@epicenter/ui/badge';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import AppWindowIcon from '@lucide/svelte/icons/app-window';

	// Only open the focused window by default
	const defaultOpenWindows = $derived(
		browserState.windows.filter((w) => w.focused).map((w) => w.id),
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
	<Accordion.Root type="multiple" value={defaultOpenWindows} class="px-2">
		{#each browserState.windows as window (window.id)}
			{@const windowTabs = browserState.tabsByWindow(window.id)}
			<Accordion.Item value={window.id}>
				<Accordion.Trigger
					class="items-center gap-2 px-2 py-2 hover:no-underline"
				>
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
				</Accordion.Trigger>
				<Accordion.Content class="pb-0">
					<!-- VList needs explicit height on parent, not max-height -->
					<!-- Use min() to cap at 400px or use full height of tabs if less -->
					<div style="height: {Math.min(windowTabs.length * 48, 400)}px;">
						<VList
							data={windowTabs}
							style="height: 100%;"
							itemSize={48}
							getKey={(tab) => tab.id}
						>
							{#snippet children(tab)}
								<div class="border-b border-border">
									<TabItem {tab} />
								</div>
							{/snippet}
						</VList>
					</div>
				</Accordion.Content>
			</Accordion.Item>
		{/each}
	</Accordion.Root>
{/if}
