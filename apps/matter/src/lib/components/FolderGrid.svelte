<script lang="ts">
	import * as Table from '@epicenter/ui/table';
	import {
		createTable as createSvelteTable,
		FlexRender,
		renderComponent,
	} from '@tanstack/svelte-table';
	import type { ColumnDef } from '@tanstack/table-core';
	import { getCoreRowModel } from '@tanstack/table-core';
	import type { FolderRead } from '$lib/model/folder';
	import type { Row } from '$lib/model/types';
	import Cell from './Cell.svelte';

	let { read, folder }: { read: FolderRead; folder: string } = $props();

	const columns = $derived(
		read.columns.map(
			(col) =>
				({
					id: col.key,
					accessorFn: (row: Row) => row.frontmatter[col.key],
					header: col.key,
					cell: ({ getValue }) =>
						renderComponent(Cell, {
							value: getValue(),
							kind: col.kind,
							array: col.array,
						}),
				}) satisfies ColumnDef<Row>,
		),
	);

	const table = createSvelteTable({
		getRowId: (row) => row.path,
		get data() {
			return read.rows;
		},
		get columns() {
			return columns;
		},
		getCoreRowModel: getCoreRowModel(),
	});
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<header class="flex items-baseline justify-between border-b px-4 py-3">
		<div>
			<h1 class="text-sm font-semibold">{folder}</h1>
			<p class="text-xs text-muted-foreground">
				{read.rows.length} rows · {read.columns.length} columns · {read.unreadable.length} unreadable
			</p>
		</div>
		<span class="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">no model · inferred</span>
	</header>

	<div class="flex-1 overflow-auto">
		<Table.Root>
			<Table.Header>
				{#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
					<Table.Row>
						{#each headerGroup.headers as header (header.id)}
							<Table.Head>
								<span class="font-medium">{header.column.id}</span>
								<span class="ml-1 text-xs font-normal text-muted-foreground">
									{read.columns.find((c) => c.key === header.column.id)?.kind}{read.columns.find(
										(c) => c.key === header.column.id,
									)?.array
										? '[]'
										: ''}
								</span>
							</Table.Head>
						{/each}
					</Table.Row>
				{/each}
			</Table.Header>
			<Table.Body>
				{#each table.getRowModel().rows as row (row.id)}
					<Table.Row>
						{#each row.getVisibleCells() as cell (cell.id)}
							<Table.Cell>
								<FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
							</Table.Cell>
						{/each}
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>

	{#if read.unreadable.length}
		<section class="border-t px-4 py-3">
			<h2 class="text-xs font-semibold text-muted-foreground">Can't read</h2>
			<ul class="mt-1 space-y-0.5">
				{#each read.unreadable as file (file.path)}
					<li class="text-xs">
						<span class="font-mono">{file.path}</span>
						<span class="text-muted-foreground"> · {file.reason}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>
