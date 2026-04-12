<script lang="ts">
	import { goto } from '$app/navigation';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import HashIcon from '@lucide/svelte/icons/hash';
	import TagIcon from '@lucide/svelte/icons/tag';
	import { format, isToday, isYesterday } from 'date-fns';
	import type { Entry } from '$lib/workspace';
	import { viewState } from '$lib/view.svelte';
	import { DateTimeString } from '@epicenter/workspace';
	import { matchesEntrySearch } from '$lib/entries.svelte';

	let { entries }: { entries: Entry[] } = $props();

	const isSearching = $derived(viewState.searchQuery.trim().length > 0);

	/** Entries matching the search query across title, subtitle, tags, and type. */
	const searchResults = $derived.by(() => {
		if (!isSearching) return [];
		return entries.filter((entry) => matchesEntrySearch(entry, viewState.searchQuery));
	});

	/** Unique types with entry counts, sorted by count descending. */
	const typeGroups = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const entry of entries) {
			for (const t of entry.type) {
				counts.set(t, (counts.get(t) ?? 0) + 1);
			}
		}
		return [...counts.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([name, count]) => ({ name, count }));
	});

	/** Unique tags with entry counts, sorted by count descending. */
	const tagGroups = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const entry of entries) {
			for (const tag of entry.tags) {
				counts.set(tag, (counts.get(tag) ?? 0) + 1);
			}
		}
		return [...counts.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([name, count]) => ({ name, count }));
	});

	/** Recent entries sorted by updatedAt, limited to 10. */
	const recentEntries = $derived(
		[...entries]
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.slice(0, 10),
	);

	function getDateLabel(dts: string): string {
		const date = DateTimeString.toDate(dts);
		if (isToday(date)) return 'Today';
		if (isYesterday(date)) return 'Yesterday';
		return format(date, 'MMM d');
	}
</script>

<Sidebar.Root collapsible="none" class="h-full w-full">
	<Sidebar.Header>
		<div class="px-2 pb-1">
			<Sidebar.Input
				placeholder="Search entries…"
				value={viewState.searchQuery}
				oninput={(e) => viewState.setSearchQuery(e.currentTarget.value)}
			/>
		</div>
	</Sidebar.Header>

	<Sidebar.Content>
		<!-- All Entries -->
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
						isActive={viewState.activeTypeFilter === null && viewState.activeTagFilter === null && !isSearching}
					onclick={() => viewState.clearFilters()}
						>
							<FileTextIcon class="size-4" />
							<span>All Entries</span>
							<span class="ml-auto text-xs text-muted-foreground">
								{entries.length}
							</span>
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>

		{#if isSearching}
			<!-- Search Results -->
			<Sidebar.Group>
				<Sidebar.GroupLabel>
					Search Results ({searchResults.length})
				</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#if searchResults.length > 0}
							{#each searchResults as entry (entry.id)}
								<Sidebar.MenuItem>
								<Sidebar.MenuButton onclick={() => goto(`/entries/${entry.id}`)}>
										<div class="flex w-full flex-col gap-0.5 overflow-hidden">
											<span class="truncate text-sm font-medium">
												{entry.title || 'Untitled'}
											</span>
											{#if entry.subtitle}
												<span class="truncate text-xs text-muted-foreground">
													{entry.subtitle}
												</span>
											{/if}
										</div>
									</Sidebar.MenuButton>
								</Sidebar.MenuItem>
							{/each}
						{:else}
							<Sidebar.MenuItem>
								<span class="px-2 py-1 text-xs text-muted-foreground">
								No entries match "{viewState.searchQuery}"
								</span>
							</Sidebar.MenuItem>
						{/if}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		{:else}
			<!-- Type Groups -->
			{#if typeGroups.length > 0}
				<Sidebar.Group>
					<Sidebar.GroupLabel>Type</Sidebar.GroupLabel>
					<Sidebar.GroupContent>
						<Sidebar.Menu>
							{#each typeGroups as group (group.name)}
								<Sidebar.MenuItem>
									<Sidebar.MenuButton
									isActive={viewState.activeTypeFilter === group.name}
									onclick={() =>
										viewState.setTypeFilter(
											viewState.activeTypeFilter === group.name ? null : group.name,
										)}
									>
										<HashIcon class="size-4" />
										<span>{group.name}</span>
										<span class="ml-auto text-xs text-muted-foreground">
											{group.count}
										</span>
									</Sidebar.MenuButton>
								</Sidebar.MenuItem>
							{/each}
						</Sidebar.Menu>
					</Sidebar.GroupContent>
				</Sidebar.Group>
			{/if}

			<!-- Tag Groups -->
			{#if tagGroups.length > 0}
				<Sidebar.Group>
					<Sidebar.GroupLabel>Tags</Sidebar.GroupLabel>
					<Sidebar.GroupContent>
						<Sidebar.Menu>
							{#each tagGroups as group (group.name)}
								<Sidebar.MenuItem>
									<Sidebar.MenuButton
									isActive={viewState.activeTagFilter === group.name}
									onclick={() =>
										viewState.setTagFilter(
											viewState.activeTagFilter === group.name ? null : group.name,
										)}
									>
										<TagIcon class="size-4" />
										<span>{group.name}</span>
										<span class="ml-auto text-xs text-muted-foreground">
											{group.count}
										</span>
									</Sidebar.MenuButton>
								</Sidebar.MenuItem>
							{/each}
						</Sidebar.Menu>
					</Sidebar.GroupContent>
				</Sidebar.Group>
			{/if}

			<!-- Recent Entries -->
			{#if recentEntries.length > 0}
				<Sidebar.Group>
					<Sidebar.GroupLabel>Recent</Sidebar.GroupLabel>
					<Sidebar.GroupContent>
						<Sidebar.Menu>
							{#each recentEntries as entry (entry.id)}
								<Sidebar.MenuItem>
								<Sidebar.MenuButton onclick={() => goto(`/entries/${entry.id}`)}>
										<div class="flex w-full flex-col gap-0.5 overflow-hidden">
											<span class="truncate text-sm font-medium">
												{entry.title || 'Untitled'}
											</span>
											<span class="truncate text-xs text-muted-foreground">
												{getDateLabel(entry.updatedAt)}
											</span>
										</div>
									</Sidebar.MenuButton>
								</Sidebar.MenuItem>
							{/each}
						</Sidebar.Menu>
					</Sidebar.GroupContent>
				</Sidebar.Group>
			{/if}
		{/if}
	</Sidebar.Content>

</Sidebar.Root>
