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
	<VList data={flatItems} style="height: 100%;">
		{#snippet children(item)}
			{#if item.kind === 'window'}
				<div
					class="sticky top-0 z-10 flex items-center gap-2 bg-muted/50 px-4 py-2 text-sm font-medium backdrop-blur"
				>
					<AppWindowIcon class="size-4 text-muted-foreground" />
					<span>
						Window
						{#if item.window.focused}
							<Badge variant="secondary" class="ml-1">focused</Badge>
						{/if}
					</span>
					<Badge variant="outline" class="ml-auto">
						{browserState.tabsByWindow(item.window.id).length}
					</Badge>
				</div>
			{:else}
				<div style="border-bottom: 1px solid rgb(229 231 235);">
					<TabItem tab={item.tab} />
				</div>
			{/if}
		{/snippet}
	</VList>
{/if}
