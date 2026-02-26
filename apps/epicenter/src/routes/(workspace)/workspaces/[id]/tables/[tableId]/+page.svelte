<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import * as Table from '@epicenter/ui/table';
	import * as Tabs from '@epicenter/ui/tabs';
	import CodeIcon from '@lucide/svelte/icons/code';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchXIcon from '@lucide/svelte/icons/search-x';
	import TableIcon from '@lucide/svelte/icons/table-2';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { page } from '$app/state';

	let { data } = $props();

	const tableId = $derived(page.params.tableId);

	/**
	 * Access the table helper from the Static workspace client by name.
	 *
	 * Static API uses `client.tables.recordings` (property access) instead of
	 * Dynamic's `client.tables.get('recordings')` (method call). The tableId
	 * route param is the table name (e.g., "recordings", "entries").
	 */
	const tableHelper = $derived.by(() => {
		if (!tableId || !data.client?.tables) return undefined;
		const tables = data.client.tables as Record<
			string,
			| {
					getAllValid: () => Record<string, unknown>[];
					count: () => number;
			  }
			| undefined
		>;
		return tables[tableId];
	});

	const rows = $derived.by(() => {
		if (!tableHelper) return [];
		return tableHelper.getAllValid();
	});

	/**
	 * Derive column names from the first row of data.
	 *
	 * Static API schemas are arktype types defined in code — they don't have
	 * runtime-introspectable Field objects like Dynamic did. Column names
	 * are inferred from actual data, excluding internal fields like `_v`.
	 */
	const columnNames = $derived.by(() => {
		if (rows.length === 0) return [];
		return Object.keys(rows[0]!).filter((k) => k !== '_v');
	});

	let activeTab = $state('data');
</script>

<div class="space-y-4">
	{#if !tableHelper}
		<Empty.Root>
			<Empty.Header>
				<Empty.Media variant="icon"> <SearchXIcon /> </Empty.Media>
				<Empty.Title>Table not found</Empty.Title>
				<Empty.Description>
					The table "{tableId}" does not exist in this workspace.
				</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<Button variant="outline" href="/workspaces/{data.definition.id}">
					Back to workspace
				</Button>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<!-- Header -->
		<div class="flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-semibold">{tableId}</h1>
				<p class="text-muted-foreground text-sm">
					{columnNames.length}
					column{columnNames.length === 1 ? '' : 's'}
					· {rows.length}
					row{rows.length === 1 ? '' : 's'}
				</p>
			</div>
			<Button disabled>
				<PlusIcon class="mr-2 size-4" />
				Add Row
			</Button>
		</div>

		<!-- Tabs -->
		<Tabs.Root bind:value={activeTab}>
			<Tabs.List>
				<Tabs.Trigger value="data">
					<DatabaseIcon class="mr-2 size-4" />
					Data
				</Tabs.Trigger>
				<Tabs.Trigger value="schema">
					<TableIcon class="mr-2 size-4" />
					Schema
				</Tabs.Trigger>
				<Tabs.Trigger value="raw">
					<CodeIcon class="mr-2 size-4" />
					Raw
				</Tabs.Trigger>
			</Tabs.List>

			<!-- Data Tab -->
			<Tabs.Content value="data">
				{#if rows.length === 0}
					<Empty.Root class="mt-4">
						<Empty.Header>
							<Empty.Media variant="icon"> <DatabaseIcon /> </Empty.Media>
							<Empty.Title>No data yet</Empty.Title>
							<Empty.Description>
								Add rows to this table to see them here.
							</Empty.Description>
						</Empty.Header>
						<Empty.Content>
							<Button disabled>
								<PlusIcon class="mr-2 size-4" />
								Add Row
							</Button>
						</Empty.Content>
					</Empty.Root>
				{:else}
					<div class="mt-4 rounded-md border">
						<Table.Root>
							<Table.Header>
								<Table.Row>
									{#each columnNames as columnName (columnName)}
										<Table.Head>{columnName}</Table.Head>
									{/each}
									<Table.Head class="w-12"></Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each rows as row (row.id)}
									<Table.Row>
										{#each columnNames as columnName (columnName)}
											<Table.Cell class="font-mono text-sm">
												{@const value = row[columnName]}
												{#if value === null || value === undefined}
													<span class="text-muted-foreground">-</span>
												{:else if typeof value === 'object'}
													<code class="bg-muted rounded px-1.5 py-0.5 text-xs">
														{JSON.stringify(value)}
													</code>
												{:else}
													{value}
												{/if}
											</Table.Cell>
										{/each}
										<Table.Cell>
											<DropdownMenu.Root>
												<DropdownMenu.Trigger>
													{#snippet child({ props }: { props: any })}
														<Button
															{...props}
															variant="ghost"
															size="icon"
															class="size-8"
														>
															<EllipsisIcon class="size-4" />
															<span class="sr-only">Open menu</span>
														</Button>
													{/snippet}
												</DropdownMenu.Trigger>
												<DropdownMenu.Content align="end">
													<DropdownMenu.Item disabled>Edit</DropdownMenu.Item>
													<DropdownMenu.Separator />
													<DropdownMenu.Item class="text-destructive" disabled>
														<TrashIcon class="mr-2 size-4" />
														Delete
													</DropdownMenu.Item>
												</DropdownMenu.Content>
											</DropdownMenu.Root>
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</div>
				{/if}
			</Tabs.Content>

			<!-- Schema Tab -->
			<Tabs.Content value="schema">
				<div class="mt-4 rounded-md border">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Column Name</Table.Head>
								<Table.Head>Sample Type</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each columnNames as columnName (columnName)}
								{@const sampleValue = rows[0]?.[columnName]}
								<Table.Row>
									<Table.Cell class="font-mono text-sm"
										>{columnName}</Table.Cell
									>
									<Table.Cell>
										<Badge variant="secondary"
											>{sampleValue === null
												? 'null'
												: typeof sampleValue}</Badge
										>
									</Table.Cell>
								</Table.Row>
							{:else}
								<Table.Row>
									<Table.Cell colspan={2} class="h-24 text-center">
										<Empty.Root>
											<Empty.Title>No columns</Empty.Title>
											<Empty.Description>
												This table has no columns defined yet.
											</Empty.Description>
										</Empty.Root>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			</Tabs.Content>

			<!-- Raw Tab -->
			<Tabs.Content value="raw">
				<div class="mt-4 rounded-lg border p-4">
					<h2 class="mb-2 font-medium">Raw Data</h2>
					<pre
						class="bg-muted overflow-auto rounded p-4 text-xs"
					>{JSON.stringify(
							rows.slice(0, 10),
							null,
							2,
						)}</pre>
				</div>
			</Tabs.Content>
		</Tabs.Root>
	{/if}
</div>
