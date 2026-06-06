<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Table from '@epicenter/ui/table';
	import FileWarningIcon from '@lucide/svelte/icons/file-warning';
	import ListFilterIcon from '@lucide/svelte/icons/list-filter';
	import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { FolderRead } from '$lib/core/folder';
	import ModeledCell from './ModeledCell.svelte';
	import RowDetail from './RowDetail.svelte';

	let {
		read,
		folder,
		onSaveField,
		onSaveBody,
	}: {
		read: FolderRead;
		folder: string;
		onSaveField: (name: string, key: string, value: unknown) => void;
		onSaveBody: (name: string, body: string) => void;
	} = $props();

	const view = $derived(read.view);

	// "Needs attention" filter: a lens over the same table, not a relayout.
	let onlyNeedsAttention = $state(false);

	const visibleRows = $derived.by(() => {
		if (view.mode !== 'modeled') return [];
		return onlyNeedsAttention
			? view.conformance.filter((c) => !c.rowValid)
			: view.conformance;
	});

	const invalidCount = $derived(
		view.mode === 'modeled' ? view.conformance.filter((c) => !c.rowValid).length : 0,
	);

	// Per-row extras expander state, keyed by file path.
	let expanded = $state<Record<string, boolean>>({});
</script>

<!-- Raw value render for the unmodeled view: plain text, no type guessing. -->
{#snippet rawValue(value: unknown)}
	{#if value === null || value === undefined}
		<span class="text-muted-foreground/50">.</span>
	{:else if Array.isArray(value)}
		<div class="flex flex-wrap gap-1">
			{#each value as item, i (i)}
				<Badge variant="secondary" class="max-w-44 truncate">
					{typeof item === 'object' ? JSON.stringify(item) : String(item)}
				</Badge>
			{/each}
		</div>
	{:else if typeof value === 'object'}
		<code class="block max-w-80 truncate text-xs text-muted-foreground">
			{JSON.stringify(value)}
		</code>
	{:else}
		<span class="block truncate">{String(value)}</span>
	{/if}
{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
	{#if view.mode === 'unmodeled'}
		<header
			class="flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-4 py-3"
		>
			<div>
				<h1 class="max-w-[70vw] truncate text-sm font-semibold">{folder}</h1>
				<div class="mt-1 flex flex-wrap gap-1.5">
					<Badge variant="secondary">{read.rows.length} rows</Badge>
					<Badge variant="secondary">{view.columns.length} columns</Badge>
					{#if read.unreadable.length}
						<Badge variant="destructive">{read.unreadable.length} unreadable</Badge>
					{/if}
				</div>
			</div>
			<Badge variant="outline">no model</Badge>
		</header>

		<Alert.Root class="rounded-none border-x-0 border-t-0 bg-muted/30" role="status">
			<FileWarningIcon />
			<Alert.Description class="text-xs">
				{#if view.modelError}
					Could not read matter.json ({view.modelError.message}). Showing the raw frontmatter; add a valid matter.json to classify files against a contract.
				{:else}
					No model for this folder. Showing the raw frontmatter; add a matter.json to classify files against a contract.
				{/if}
			</Alert.Description>
		</Alert.Root>

		<div class="flex-1 overflow-auto">
			<Table.Root class="min-w-full text-sm">
				<Table.Header>
					<Table.Row>
						{#each view.columns as key (key)}
							<Table.Head class="sticky top-0 z-10 bg-background">
								<span class="font-medium">{key}</span>
							</Table.Head>
						{/each}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#if read.rows.length === 0}
						<Table.Row>
							<Table.Cell colspan={Math.max(1, view.columns.length)}>
								<Empty.Root class="min-h-64 border-0">
									<Empty.Title>No readable rows</Empty.Title>
									<Empty.Description>
										Add markdown files with frontmatter to see them here.
									</Empty.Description>
								</Empty.Root>
							</Table.Cell>
						</Table.Row>
					{:else}
						{#each read.rows as row (row.name)}
							<Table.Row>
								{#each view.columns as key (key)}
									<Table.Cell>{@render rawValue(row.frontmatter[key])}</Table.Cell>
								{/each}
							</Table.Row>
						{/each}
					{/if}
				</Table.Body>
			</Table.Root>
		</div>
	{:else}
		<header
			class="flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-4 py-3"
		>
			<div>
				<h1 class="max-w-[70vw] truncate text-sm font-semibold">{folder}</h1>
				<div class="mt-1 flex flex-wrap gap-1.5">
					<Badge variant="secondary">{read.rows.length} rows</Badge>
					<Badge variant="secondary">{view.model.fields.length} fields</Badge>
					<Badge
						variant={invalidCount ? 'outline' : 'secondary'}
						class={invalidCount
							? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
							: ''}
					>
						{invalidCount} need attention
					</Badge>
					{#if read.unreadable.length}
						<Badge variant="destructive">{read.unreadable.length} unreadable</Badge>
					{/if}
				</div>
			</div>
			<Button
				variant={onlyNeedsAttention ? 'secondary' : 'outline'}
				size="sm"
				onclick={() => (onlyNeedsAttention = !onlyNeedsAttention)}
			>
				<ListFilterIcon />
				Needs attention{invalidCount ? ` (${invalidCount})` : ''}
			</Button>
		</header>

		{#if view.model.unmodeled.length}
			<Alert.Root class="rounded-none border-x-0 border-t-0 bg-muted/30" role="status">
				<TriangleAlertIcon />
				<Alert.Description class="text-xs">
					{view.model.unmodeled.length}
					{view.model.unmodeled.length === 1 ? 'field has' : 'fields have'} an unrecognized
					shape ({view.model.unmodeled.join(', ')}). Values show raw in the row detail panel, not as typed columns.
				</Alert.Description>
			</Alert.Root>
		{/if}

		<div class="flex-1 overflow-auto">
			<Table.Root class="min-w-full text-sm">
				<Table.Header>
					<Table.Row>
						<Table.Head class="sticky top-0 z-10 w-10 bg-background"></Table.Head>
						{#each view.model.fields as field (field.name)}
							<Table.Head class="sticky top-0 z-10 min-w-44 bg-background">
								<div class="flex items-baseline gap-2">
									<span class="truncate font-medium">{field.name}</span>
									<span class="text-xs font-normal text-muted-foreground">
										{field.kind}
									</span>
								</div>
							</Table.Head>
						{/each}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#if visibleRows.length === 0}
						<Table.Row>
							<Table.Cell colspan={view.model.fields.length + 1}>
								<Empty.Root class="min-h-64 border-0">
									<Empty.Title>
										{onlyNeedsAttention ? 'No rows need attention' : 'No rows yet'}
									</Empty.Title>
									<Empty.Description>
										{onlyNeedsAttention
											? 'Every readable row matches this model.'
											: 'Add markdown files with frontmatter to see them here.'}
									</Empty.Description>
								</Empty.Root>
							</Table.Cell>
						</Table.Row>
					{:else}
						{#each visibleRows as conf (conf.row.name)}
							<Table.Row class={conf.rowValid ? '' : 'bg-amber-500/5'}>
								<Table.Cell class="align-top">
									<Button
										variant="ghost"
										size="icon-xs"
										tooltip={conf.extras.length
											? `Edit body, ${conf.extras.length} unmodeled keys`
											: 'Edit body'}
										onclick={() =>
											(expanded[conf.row.name] = !expanded[conf.row.name])}
									>
										<MoreHorizontalIcon />
									</Button>
								</Table.Cell>
								{#each conf.cells as cell (cell.field.name)}
									<Table.Cell
										aria-invalid={cell.state === 'INVALID' || cell.state === 'NEEDS_VALUE'}
										class={cell.state === 'INVALID' || cell.state === 'NEEDS_VALUE'
											? 'bg-destructive/5 ring-1 ring-inset ring-destructive/20'
											: ''}
									>
										<ModeledCell
											{cell}
											save={(value) => onSaveField(conf.row.name, cell.field.name, value)}
											clear={() => onSaveField(conf.row.name, cell.field.name, undefined)}
										/>
									</Table.Cell>
								{/each}
							</Table.Row>
							{#if expanded[conf.row.name]}
								<Table.Row>
									<Table.Cell></Table.Cell>
									<Table.Cell colspan={view.model.fields.length} class="p-0">
										<RowDetail row={conf.row} extras={conf.extras} {onSaveBody} />
									</Table.Cell>
								</Table.Row>
							{/if}
						{/each}
					{/if}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}

	{#if read.unreadable.length}
		<section class="border-t bg-muted/20 px-4 py-3">
			<div class="flex items-center gap-2">
				<FileWarningIcon class="size-4 text-muted-foreground" />
				<h2 class="text-xs font-semibold text-muted-foreground">Can't read</h2>
			</div>
			<ul class="mt-1 space-y-0.5">
				{#each read.unreadable as file (file.name)}
					<li class="text-xs">
						<span class="font-mono">{file.name}</span>
						<span class="text-muted-foreground"> / {file.error.message}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>
