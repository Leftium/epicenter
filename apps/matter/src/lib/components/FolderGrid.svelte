<script lang="ts">
	import * as Table from '@epicenter/ui/table';
	import type { FolderRead } from '$lib/model/view';
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
		<span class="text-muted-foreground/50">·</span>
	{:else if Array.isArray(value)}
		<div class="flex flex-wrap gap-1">
			{#each value as item, i (i)}
				<span class="rounded bg-muted px-1.5 py-0.5 text-xs">
					{typeof item === 'object' ? JSON.stringify(item) : String(item)}
				</span>
			{/each}
		</div>
	{:else if typeof value === 'object'}
		<code class="text-xs text-muted-foreground">{JSON.stringify(value)}</code>
	{:else}
		<span class="truncate">{String(value)}</span>
	{/if}
{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
	{#if view.mode === 'unmodeled'}
		<header class="flex items-baseline justify-between border-b px-4 py-3">
			<div>
				<h1 class="text-sm font-semibold">{folder}</h1>
				<p class="text-xs text-muted-foreground">
					{read.rows.length} rows · {view.columns.length} columns · {read.unreadable.length} unreadable
				</p>
			</div>
			<span class="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">no model</span>
		</header>

		<div class="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
			{#if view.modelError}
				Could not read matter.json ({view.modelError.message}). Showing the raw frontmatter; add a valid matter.json to classify files against a contract.
			{:else}
				No model for this folder. Showing the raw frontmatter; add a matter.json to classify files against a contract.
			{/if}
		</div>

		<div class="flex-1 overflow-auto">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						{#each view.columns as key (key)}
							<Table.Head><span class="font-medium">{key}</span></Table.Head>
						{/each}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each read.rows as row (row.name)}
						<Table.Row>
							{#each view.columns as key (key)}
								<Table.Cell>{@render rawValue(row.frontmatter[key])}</Table.Cell>
							{/each}
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{:else}
		<header class="flex items-baseline justify-between border-b px-4 py-3">
			<div>
				<h1 class="text-sm font-semibold">{folder}</h1>
				<p class="text-xs text-muted-foreground">
					{read.rows.length} rows · {view.model.fields.length} fields · {invalidCount} need attention · {read
						.unreadable.length} unreadable
				</p>
			</div>
			<button
				type="button"
				class="rounded border px-2 py-1 text-xs {onlyNeedsAttention
					? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
					: 'text-muted-foreground'}"
				onclick={() => (onlyNeedsAttention = !onlyNeedsAttention)}
			>
				Needs attention{invalidCount ? ` (${invalidCount})` : ''}
			</button>
		</header>

		{#if view.model.unmodeled.length}
			<div class="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
				{view.model.unmodeled.length}
				{view.model.unmodeled.length === 1 ? 'field has' : 'fields have'} an unrecognized
				shape ({view.model.unmodeled.join(', ')}); their values show raw in the ••• expander, not as typed columns.
			</div>
		{/if}

		<div class="flex-1 overflow-auto">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="w-8"></Table.Head>
						{#each view.model.fields as field (field.name)}
							<Table.Head>
								<span class="font-medium">{field.name}</span>
								<span class="ml-1 text-xs font-normal text-muted-foreground">
									{field.kind}
								</span>
							</Table.Head>
						{/each}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each visibleRows as conf (conf.row.name)}
						<Table.Row class={conf.rowValid ? '' : 'bg-amber-500/5'}>
							<Table.Cell class="align-top">
								<button
									type="button"
									class="text-muted-foreground hover:text-foreground"
									title="Edit body{conf.extras.length
										? ` · ${conf.extras.length} unmodeled keys`
										: ''}"
									onclick={() =>
										(expanded[conf.row.name] = !expanded[conf.row.name])}
								>
									•••
								</button>
							</Table.Cell>
							{#each conf.cells as cell (cell.field.name)}
								<Table.Cell
									class={cell.state === 'INVALID' || cell.state === 'NEEDS_VALUE'
										? 'ring-1 ring-inset ring-destructive/20'
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
								<Table.Cell colspan={view.model.fields.length}>
									<RowDetail row={conf.row} extras={conf.extras} {onSaveBody} />
								</Table.Cell>
							</Table.Row>
						{/if}
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}

	{#if read.unreadable.length}
		<section class="border-t px-4 py-3">
			<h2 class="text-xs font-semibold text-muted-foreground">Can't read</h2>
			<ul class="mt-1 space-y-0.5">
				{#each read.unreadable as file (file.name)}
					<li class="text-xs">
						<span class="font-mono">{file.name}</span>
						<span class="text-muted-foreground"> · {file.error.message}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>
