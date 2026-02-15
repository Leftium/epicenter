<script lang="ts">
	import { savedTabState } from '$lib/state/saved-tab-state.svelte';
	import { getDomain, getRelativeTime } from '$lib/utils/format';
	import TabFavicon from './TabFavicon.svelte';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import BookmarkIcon from '@lucide/svelte/icons/bookmark';
</script>

<section class="flex flex-col gap-2 p-4">
	{#if !savedTabState.tabs.length}
		<Empty.Root class="py-8">
			<Empty.Media>
				<BookmarkIcon class="size-8 text-muted-foreground" />
			</Empty.Media>
			<Empty.Title>No saved tabs</Empty.Title>
			<Empty.Description>Save tabs to come back to them later</Empty.Description
			>
		</Empty.Root>
	{:else}
		<Item.Group>
			{#each savedTabState.tabs as tab (tab.id)}
				<Item.Root size="sm" class="hover:bg-accent/50">
					<Item.Media>
						<TabFavicon src={tab.favIconUrl} />
					</Item.Media>

					<Item.Content>
						<Item.Title>
							<span class="truncate">{tab.title || 'Untitled'}</span>
						</Item.Title>
						<Item.Description class="flex items-center gap-2 truncate">
							<span class="truncate">{getDomain(tab.url)}</span>
							<span>•</span>
							<span class="shrink-0">{getRelativeTime(tab.savedAt)}</span>
						</Item.Description>
					</Item.Content>

					<Item.Actions showOnHover class="gap-1">
						<Button
							variant="ghost"
							size="icon-xs"
							tooltip="Restore"
							onclick={() => savedTabState.actions.restore(tab)}
						>
							<RotateCcwIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-xs"
							class="text-destructive"
							tooltip="Delete"
							onclick={() => savedTabState.actions.remove(tab.id)}
						>
							<Trash2Icon />
						</Button>
					</Item.Actions>
				</Item.Root>
			{/each}
		</Item.Group>

		<div class="mt-2 flex justify-end gap-2 border-t pt-2">
			<Button
				variant="outline"
				size="sm"
				onclick={() => savedTabState.actions.restoreAll()}
			>
				Restore All
			</Button>
			<Button
				variant="destructive"
				size="sm"
				onclick={() => savedTabState.actions.removeAll()}
			>
				Delete All
			</Button>
		</div>
	{/if}
</section>
