<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as ScrollArea from '@epicenter/ui/scroll-area';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { format, isToday, isYesterday } from 'date-fns';
	import type { Entry } from '$lib/workspace';
	import { DateTimeString } from '@epicenter/workspace';
	import { viewState } from '$lib/view.svelte';
	import { workspace } from '$lib/client';

	let { entries }: { entries: Entry[] } = $props();

	function createEntry() {
		const { id } = workspace.actions.entries.create({});
		viewState.selectEntry(id);
	}

	/** Which timestamp field to use for sorting and grouping. */
	const dateField = $derived(
		viewState.sortBy === 'title' ? 'date' as const : viewState.sortBy as 'date' | 'updatedAt' | 'createdAt',
	);

	function getDateLabel(dts: string): string {
		const date = DateTimeString.toDate(dts);
		if (isToday(date)) return 'Today';
		if (isYesterday(date)) return 'Yesterday';
		return format(date, 'MMMM d');
	}

	/** Entries grouped by date label, sorted newest first. */
	const groupedEntries = $derived.by(() => {
		const field = dateField;
		const sorted = [...entries].sort((a, b) =>
			b[field].localeCompare(a[field]),
		);

		const groups: { label: string; entries: Entry[] }[] = [];
		let currentLabel = '';
		let currentGroup: Entry[] = [];

		for (const entry of sorted) {
			const label = getDateLabel(entry[field]);
			if (label !== currentLabel) {
				if (currentGroup.length > 0) {
					groups.push({ label: currentLabel, entries: currentGroup });
				}
				currentLabel = label;
				currentGroup = [entry];
			} else {
				currentGroup.push(entry);
			}
		}

		if (currentGroup.length > 0) {
			groups.push({ label: currentLabel, entries: currentGroup });
		}

		return groups;
	});
</script>

<div class="flex h-full flex-col">
	<!-- Header -->
	<div class="flex items-center justify-between border-b px-4 py-3">
		<h2 class="text-sm font-semibold">Timeline</h2>
		<Button variant="ghost" size="icon" class="size-7" onclick={createEntry}>
			<PlusIcon class="size-4" />
		</Button>
	</div>

	<!-- Timeline -->
	<ScrollArea.Root class="flex-1">
		{#if entries.length === 0}
			<Empty.Root class="flex-1">
				<Empty.Media>
					<ClockIcon class="size-8 text-muted-foreground" />
				</Empty.Media>
				<Empty.Title>No entries yet</Empty.Title>
				<Empty.Description>Create your first entry to get started.</Empty.Description>
				<Empty.Content>
					<Button variant="outline" size="sm" onclick={createEntry}>
						<PlusIcon class="mr-1.5 size-4" />
						New Entry
					</Button>
				</Empty.Content>
			</Empty.Root>
		{:else}
			<div class="flex flex-col gap-4 p-4">
				{#each groupedEntries as group}
					<div class="flex flex-col gap-1">
						<h3 class="px-2 text-xs font-medium text-muted-foreground">
							{group.label}
						</h3>
						{#each group.entries as entry (entry.id)}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="group flex cursor-pointer flex-col gap-0.5 rounded-lg p-3 text-sm transition-colors hover:bg-accent/50 {viewState.selectedEntryId ===
								entry.id
									? 'bg-accent'
									: ''}"
								onclick={() => viewState.selectEntry(entry.id)}
							>
								<div class="flex items-start justify-between gap-2">
									<span class="font-medium line-clamp-1">
										{entry.title || 'Untitled'}
									</span>
									<span class="shrink-0 text-xs text-muted-foreground">
										{format(DateTimeString.toDate(entry.updatedAt), 'h:mm a')}
									</span>
								</div>
							{#if entry.subtitle}
								<p class="line-clamp-1 text-xs text-muted-foreground">
									{entry.subtitle}
								</p>
							{/if}
							</div>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	</ScrollArea.Root>
</div>
