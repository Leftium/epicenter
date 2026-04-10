<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Table from '@epicenter/ui/table';
	import { SortableTableHeader } from '@epicenter/ui/table';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import {
		createTable as createSvelteTable,
		FlexRender,
		renderComponent,
	} from '@tanstack/svelte-table';
	import type { ColumnDef } from '@tanstack/table-core';
	import {
		getCoreRowModel,
		getFilteredRowModel,
		getSortedRowModel,
	} from '@tanstack/table-core';
	import { formatDistanceToNowStrict } from 'date-fns';
	import type { Entry } from '$lib/workspace';
	import BadgeList from './BadgeList.svelte';
	import { DateTimeString } from '@epicenter/workspace';
	import { entriesState, matchesEntrySearch } from '$lib/entries.svelte';
	import { viewState } from '$lib/view.svelte';

	let { entries }: { entries: Entry[] } = $props();


	function relativeTime(dts: string): string {
		try {
			return formatDistanceToNowStrict(DateTimeString.toDate(dts), {
				addSuffix: true,
			});
		} catch {
			return dts;
		}
	}

	const columns: ColumnDef<Entry>[] = [
		{
			id: 'title',
			accessorKey: 'title',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Title',
				}),
			cell: ({ getValue }) => {
				const title = getValue<string>();
				return title || 'Untitled';
			},
		},
		{
			id: 'subtitle',
			accessorKey: 'subtitle',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Subtitle',
				}),
			cell: ({ getValue }) => {
				const subtitle = getValue<string>();
				return subtitle || '';
			},
		},
		{
			id: 'type',
			accessorKey: 'type',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Type',
				}),
			cell: ({ getValue }) => {
				const types = getValue<string[]>();
				if (!types.length) return '';
				return renderComponent(BadgeList, { items: types });
			},
			enableSorting: false,
		},
		{
			id: 'tags',
			accessorKey: 'tags',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Tags',
				}),
			cell: ({ getValue }) => {
				const tags = getValue<string[]>();
				if (!tags.length) return '';
				return renderComponent(BadgeList, { items: tags });
			},
			enableSorting: false,
		},
		{
			id: 'date',
			accessorKey: 'date',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Date',
				}),
			cell: ({ getValue }) => relativeTime(getValue<string>()),
		},
		{
			id: 'createdAt',
			accessorKey: 'createdAt',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Created',
				}),
			cell: ({ getValue }) => relativeTime(getValue<string>()),
		},
		{
			id: 'updatedAt',
			accessorKey: 'updatedAt',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Updated',
				}),
			cell: ({ getValue }) => relativeTime(getValue<string>()),
		},
	];

	let sorting = $state([{ id: viewState.sortBy, desc: viewState.sortBy !== 'title' }]);

	const table = createSvelteTable({
		getRowId: (row) => row.id,
		get data() {
			return entries;
		},
		columns,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		onSortingChange: (updater) => {
			if (typeof updater === 'function') {
				sorting = updater(sorting);
			} else {
				sorting = updater;
			}
			// Propagate sort change back to persisted KV
			const primary = sorting[0];
			if (primary) {
				viewState.sortBy = primary.id as typeof viewState.sortBy;
			}
		},
		state: {
			get sorting() {
				return sorting;
			},
			get globalFilter() {
				return viewState.searchQuery;
			},
		},
		globalFilterFn: (row, _columnId, filterValue) => {
			return matchesEntrySearch(row.original, filterValue);
		},
	});
</script>

<div class="flex h-full flex-col">
	<!-- Toolbar -->
	<div class="flex items-center justify-between border-b px-4 py-3">
		<h2 class="text-sm font-semibold">Entries</h2>
		<Button variant="ghost" size="icon" class="size-7" onclick={entriesState.createEntry}>
			<PlusIcon class="size-4" />
		</Button>
	</div>

	<!-- Table -->
	<div class="flex-1 overflow-auto">
		<Table.Root>
			<Table.Header>
				{#each table.getHeaderGroups() as headerGroup}
					<Table.Row>
						{#each headerGroup.headers as header}
							<Table.Head colspan={header.colSpan}>
								{#if !header.isPlaceholder}
									<FlexRender
										content={header.column.columnDef.header}
										context={header.getContext()}
									/>
								{/if}
							</Table.Head>
						{/each}
					</Table.Row>
				{/each}
			</Table.Header>
			<Table.Body>
				{#if table.getRowModel().rows?.length}
					{#each table.getRowModel().rows as row (row.id)}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<Table.Row
							class="cursor-pointer transition-colors hover:bg-accent/50 {viewState.selectedEntryId === row.id
								? 'bg-accent'
								: ''}"
							onclick={() => viewState.selectEntry(row.original.id)}
						>
							{#each row.getVisibleCells() as cell}
								<Table.Cell>
									<FlexRender
										content={cell.column.columnDef.cell}
										context={cell.getContext()}
									/>
								</Table.Cell>
							{/each}
						</Table.Row>
					{/each}
				{:else}
					<Table.Row>
						<Table.Cell colspan={columns.length}>
							<Empty.Root>
								<Empty.Media>
									<FileTextIcon class="size-8 text-muted-foreground" />
								</Empty.Media>
								{#if viewState.searchQuery}
									<Empty.Title>No entries match your search</Empty.Title>
									<Empty.Description>Try a different search term or clear your filters.</Empty.Description>
								{:else}
									<Empty.Title>No entries yet</Empty.Title>
									<Empty.Description>Create your first entry to get started.</Empty.Description>
									<Empty.Content>
										<Button variant="outline" size="sm" onclick={entriesState.createEntry}>
											<PlusIcon class="mr-1.5 size-4" />
											New Entry
										</Button>
									</Empty.Content>
								{/if}
							</Empty.Root>
						</Table.Cell>
					</Table.Row>
				{/if}
			</Table.Body>
		</Table.Root>
	</div>
</div>
