<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Toggle } from '@epicenter/ui/toggle';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import CaseSensitiveIcon from '@lucide/svelte/icons/case-sensitive';
	import RegexIcon from '@lucide/svelte/icons/regex';
	import SearchIcon from '@lucide/svelte/icons/search';
	import XIcon from '@lucide/svelte/icons/x';
	import { requireWorkspace } from '$lib/session';
	import SearchResultGroup from './SearchResultGroup.svelte';

	const workspace = requireWorkspace();
	let searchInputRef = $state<HTMLInputElement | null>(null);
	let searchFocused = $state(false);

	const isSearchActive = $derived(
		searchFocused || workspace.state.sidebarSearch.searchQuery !== '',
	);
	const hasQuery = $derived(
		workspace.state.sidebarSearch.searchQuery.trim().length >= 2,
	);
	const hasResults = $derived(
		workspace.state.sidebarSearch.fileGroups.length > 0,
	);

	export function focusInput() {
		searchInputRef?.focus();
	}
</script>

{#snippet searchToggle(pressed: boolean, onPressedChange: (v: boolean) => void, Icon:typeof CaseSensitiveIcon, label: string)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Toggle
					size="sm"
					{pressed}
					{onPressedChange}
					aria-label={label}
					class="size-6 rounded-sm p-0"
					{...props}
				>
					<Icon class="size-3.5" />
				</Toggle>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>{label}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

<div class="flex h-full flex-col">
	<div class="border-b p-2">
		<div
			class="relative"
			onfocusin={() => {
				searchFocused = true;
			}}
			onfocusout={(e: FocusEvent) => {
				const container = e.currentTarget as HTMLElement;
				if (container.contains(e.relatedTarget as Node)) return;
				searchFocused = false;
			}}
		>
			<SearchIcon
				class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				bind:ref={searchInputRef}
				type="search"
				placeholder="Search files..."
				value={workspace.state.sidebarSearch.searchQuery}
				oninput={(e: Event) => {
					workspace.state.sidebarSearch.searchQuery = (e.target as HTMLInputElement).value;
				}}
				onkeydown={(e: KeyboardEvent) => {
					if (e.key === 'Escape') {
						if (workspace.state.sidebarSearch.searchQuery === '') {
							workspace.state.sidebarSearch.closeSearch();
						} else {
							workspace.state.sidebarSearch.searchQuery = '';
						}
					}
				}}
				class={isSearchActive
					? 'h-8 pl-8 pr-20 text-sm [&::-webkit-search-cancel-button]:hidden'
					: 'h-8 pl-8 pr-8 text-sm [&::-webkit-search-cancel-button]:hidden'}
			/>
			{#if isSearchActive}
				<div
					class="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5"
				>
					{#if workspace.state.sidebarSearch.searchQuery}
						<button
							type="button"
							class="flex size-6 items-center justify-center text-muted-foreground hover:text-foreground"
							onclick={() => {
								workspace.state.sidebarSearch.searchQuery = '';
								searchInputRef?.focus();
							}}
						>
							<XIcon class="size-3.5" />
						</button>
					{/if}
					{@render searchToggle(
						workspace.state.sidebarSearch.caseSensitive,
						(v) => {
							workspace.state.sidebarSearch.caseSensitive = v;
						},
						CaseSensitiveIcon,
						'Match Case'
					)}
					{@render searchToggle(
						workspace.state.sidebarSearch.regex,
						(v) => {
							workspace.state.sidebarSearch.regex = v;
						},
						RegexIcon,
						'Use Regular Expression'
					)}
				</div>
			{/if}
		</div>
	</div>

	{#if workspace.state.sidebarSearch.isSearching && !hasResults}
		<Loading class="flex-1" />
	{:else if hasResults}
		<div class="border-b px-3 py-1.5 text-xs text-muted-foreground">
			{workspace.state.sidebarSearch.totalResults}
			result{workspace.state.sidebarSearch.totalResults === 1
				? ''
				: 's'}
			in
			{workspace.state.sidebarSearch.totalFiles}
			file{workspace.state.sidebarSearch.totalFiles === 1
				? ''
				: 's'}
			{#if workspace.state.sidebarSearch.isSearching}
				<Spinner class="ml-1 inline-block size-3" />
			{/if}
		</div>
		<ScrollArea class="flex-1">
			<div class="p-1">
				{#each workspace.state.sidebarSearch.fileGroups as group (group.fileId)}
					<SearchResultGroup {group} defaultOpen={group.matchCount <= 5} />
				{/each}
				{#if workspace.state.sidebarSearch.hasMore}
					<button
						type="button"
						class="flex w-full items-center justify-center gap-1.5 rounded-sm px-3 py-2 text-center text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
						onclick={() => workspace.state.sidebarSearch.loadMore()}
						disabled={workspace.state.sidebarSearch.isSearching}
					>
						{#if workspace.state.sidebarSearch.isSearching}
							<Spinner class="size-3" />
							<span>Loading</span>
						{:else}
							Load more results
						{/if}
					</button>
				{/if}
			</div>
		</ScrollArea>
	{:else if hasQuery && !workspace.state.sidebarSearch.isSearching}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media>
				<SearchIcon class="size-8 text-muted-foreground" />
			</Empty.Media>
			<Empty.Header>
				<Empty.Title>No results</Empty.Title>
				<Empty.Description
					>No matches for "{workspace.state.sidebarSearch.searchQuery}"</Empty.Description
				>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media>
				<SearchIcon class="size-8 text-muted-foreground" />
			</Empty.Media>
			<Empty.Header>
				<Empty.Title>Search files</Empty.Title>
				<Empty.Description
					>Type to search file names and content</Empty.Description
				>
			</Empty.Header>
		</Empty.Root>
	{/if}
</div>
