<script lang="ts">
	import * as Table from '@epicenter/ui/table';
	import {
		createTable as createSvelteTable,
		FlexRender,
		renderComponent,
	} from '@tanstack/svelte-table';
	import type { ColumnDef } from '@tanstack/table-core';
	import { getCoreRowModel } from '@tanstack/table-core';
	import type { InferredColumn } from '$lib/model/infer';
	import type { Row } from '$lib/model/types';
	import Cell from './Cell.svelte';

	let { rows, columns: cols }: { rows: Row[]; columns: InferredColumn[] } = $props();

	const columns = $derived(
		cols.map(
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
			return rows;
		},
		get columns() {
			return columns;
		},
		getCoreRowModel: getCoreRowModel(),
	});
</script>

<div class="flex-1 overflow-auto">
	<Table.Root>
		<Table.Header>
			{#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
				<Table.Row>
					{#each headerGroup.headers as header (header.id)}
						<Table.Head>
							<span class="font-medium">{header.column.id}</span>
							<span class="ml-1 text-xs font-normal text-muted-foreground">
								{cols.find((c) => c.key === header.column.id)?.kind}{cols.find(
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
