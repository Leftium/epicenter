<script lang="ts">
	import { VList } from 'virtua/svelte';
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

{#if !savedTabState.tabs.length}
	<Empty.Root class="py-8">
		<Empty.Media>
			<BookmarkIcon class="size-8 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>No saved tabs</Empty.Title>
		<Empty.Description>Save tabs to come back to them later</Empty.Description>
	</Empty.Root>
{:else}
	<div class="flex flex-col h-full">
		<div class="flex-1 min-h-0">
			<VList
				data={savedTabState.tabs}
				style="height: 100%;"
				getKey={(tab) => tab.id}
			>
				{#snippet children(tab)}
					<div class="border-b border-border">
						<Item.Root size="sm" class="hover:bg-accent/50">
							<Item.Media>
								<TabFavicon src={tab.favIconUrl} />
							</Item.Media>

							<Item.Content>
								<Item.Title>
									<span class="truncate">{tab.title || 'Untitled'}</span>
								</Item.Title>
								<Item.Description class="flex min-w-0 items-center gap-2 truncate">
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
					</div>
				{/snippet}
			</VList>
		</div>

		<div class="flex justify-end gap-2 border-t px-4 py-2">
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
	</div>
{/if}
