<script lang="ts">
	import * as Table from '@epicenter/ui/table';
	import type { FolderRead } from '$lib/model/folder';
	import InferredGrid from './InferredGrid.svelte';
	import ConformanceCell from './ConformanceCell.svelte';

	let { read, folder }: { read: FolderRead; folder: string } = $props();

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

<div class="flex min-h-0 flex-1 flex-col">
	{#if view.mode === 'inferred'}
		<header class="flex items-baseline justify-between border-b px-4 py-3">
			<div>
				<h1 class="text-sm font-semibold">{folder}</h1>
				<p class="text-xs text-muted-foreground">
					{read.rows.length} rows · {view.columns.length} columns · {read.unreadable.length} unreadable
				</p>
			</div>
			<span class="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
				no model · inferred
			</span>
		</header>

		{#if view.modelError}
			<div class="border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
				Could not read matter.json ({view.modelError}). Showing an inferred preview instead.
			</div>
		{/if}

		<InferredGrid rows={read.rows} columns={view.columns} />
	{:else}
		<header class="flex items-baseline justify-between border-b px-4 py-3">
			<div>
				<h1 class="text-sm font-semibold">{folder}</h1>
				<p class="text-xs text-muted-foreground">
					{read.rows.length} rows · {view.columns.length} fields · {invalidCount} need attention · {read
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

		<div class="flex-1 overflow-auto">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="w-8"></Table.Head>
						{#each view.columns as col (col.name)}
							{@const derived = view.model.fields.find((f) => f.name === col.name)?.derived}
							<Table.Head>
								<span class="font-medium">{col.name}</span>
								<span class="ml-1 text-xs font-normal text-muted-foreground">
									{derived?.kind}{derived?.kind === 'array' ? '[]' : ''}{col.nullable ? '?' : ''}
								</span>
							</Table.Head>
						{/each}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each visibleRows as conf (conf.row.path)}
						<Table.Row class={conf.rowValid ? '' : 'bg-amber-500/5'}>
							<Table.Cell class="align-top">
								{#if conf.extras.length}
									<button
										type="button"
										class="text-muted-foreground hover:text-foreground"
										title="{conf.extras.length} unmodeled keys"
										onclick={() =>
											(expanded[conf.row.path] = !expanded[conf.row.path])}
									>
										•••
									</button>
								{/if}
							</Table.Cell>
							{#each conf.cells as cell, i (cell.name)}
								{@const derived = view.model.fields[i]?.derived}
								<Table.Cell
									class={cell.state === 'INVALID' || cell.state === 'NEEDS_VALUE'
										? 'ring-1 ring-inset ring-destructive/20'
										: ''}
								>
									{#if derived}
										<ConformanceCell {cell} derivedKind={derived} />
									{/if}
								</Table.Cell>
							{/each}
						</Table.Row>
						{#if expanded[conf.row.path] && conf.extras.length}
							<Table.Row>
								<Table.Cell></Table.Cell>
								<Table.Cell colspan={view.columns.length}>
									<div class="flex flex-col gap-1 text-xs">
										<span class="text-muted-foreground">Unmodeled keys (preserved, not validated):</span>
										{#each conf.extras as extra (extra.key)}
											<div class="font-mono">
												<span class="text-muted-foreground">{extra.key}:</span>
												{typeof extra.value === 'object'
													? JSON.stringify(extra.value)
													: String(extra.value)}
											</div>
										{/each}
									</div>
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
