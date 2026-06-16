<script lang="ts">
	import { referenceTargetOf } from '@epicenter/field';
	import { Badge } from '@epicenter/ui/badge';
	import * as Table from '@epicenter/ui/table';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import Link2Icon from '@lucide/svelte/icons/link-2';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import UnlinkIcon from '@lucide/svelte/icons/unlink';
	import type { Cell } from '$lib/core/conformance';
	import type { FolderRead } from '$lib/core/folder';
	import { stemOf } from '$lib/core/parse';
	import type { ReferenceCell } from './references-demo.svelte';

	// One folder rendered as a Notion-like database: reference columns become relation chips,
	// every other column a plain cell. The verdict for each reference cell comes from the demo
	// state's `cellFor` (which defers to the real `checkReferences` report), so the chip colors
	// match what the validator would report — this view never re-decides resolution itself.
	let {
		table,
		read,
		cellFor,
	}: {
		table: string;
		read: FolderRead;
		cellFor: (
			table: string,
			fileName: string,
			fieldName: string,
			target: string,
		) => ReferenceCell;
	} = $props();

	const view = $derived(read.view);
</script>

<!-- A non-reference cell: just enough kinds to read the table; not the full grid editor. -->
{#snippet valueCell(cell: Cell)}
	{#if cell.state === 'MISSING_REQUIRED' || cell.state === 'MISSING_OPTIONAL'}
		<span class="text-muted-foreground/40">—</span>
	{:else if cell.state === 'INVALID'}
		<span class="text-destructive">{String(cell.raw)}</span>
	{:else if cell.field.kind === 'select'}
		<Badge variant="outline" class="font-normal">{String(cell.value)}</Badge>
	{:else if cell.field.kind === 'boolean'}
		<span>{cell.value ? 'Yes' : 'No'}</span>
	{:else if cell.field.kind === 'url'}
		<span class="block max-w-44 truncate text-muted-foreground" title={String(cell.value)}>
			{String(cell.value)}
		</span>
	{:else}
		<span class="block max-w-56 truncate">{String(cell.value)}</span>
	{/if}
{/snippet}

<!-- A relation chip: Notion's linked-record pill, colored by the validator's verdict. -->
{#snippet relationCell(ref: ReferenceCell)}
	{#if ref.kind === 'empty'}
		<span class="text-muted-foreground/40">—</span>
	{:else if ref.kind === 'resolved'}
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Badge {...props} variant="secondary" class="cursor-default gap-1 font-normal">
						<Link2Icon class="size-3" />
						{ref.title}
					</Badge>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>
				Resolves to <span class="font-mono">{ref.target}/{ref.targetFile}</span>
			</Tooltip.Content>
		</Tooltip.Root>
	{:else if ref.kind === 'dangling'}
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Badge {...props} variant="destructive" class="cursor-default gap-1 font-normal">
						<TriangleAlertIcon class="size-3" />
						{ref.value}
					</Badge>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>
				No row <span class="font-mono">{ref.value}</span> in
				<span class="font-mono">{ref.target}</span> — dangling reference
			</Tooltip.Content>
		</Tooltip.Root>
	{:else}
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Badge
						{...props}
						variant="outline"
						class="cursor-default gap-1 border-amber-500/40 font-normal text-amber-600 dark:text-amber-400"
					>
						<UnlinkIcon class="size-3" />
						{ref.value}
					</Badge>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>
				Target table <span class="font-mono">{ref.target}</span> is not loaded
			</Tooltip.Content>
		</Tooltip.Root>
	{/if}
{/snippet}

<section class="rounded-lg border bg-card">
	<header class="flex items-center gap-2 border-b px-3 py-2">
		<h2 class="text-sm font-semibold">{table}</h2>
		<Badge variant="secondary" class="font-mono text-[11px]">{read.rows.length} rows</Badge>
	</header>

	{#if view.mode !== 'modeled'}
		<p class="px-3 py-4 text-xs text-muted-foreground">No model for this folder.</p>
	{:else}
		<div class="overflow-x-auto">
			<Table.Root class="text-xs">
				<Table.Header>
					<Table.Row>
						<Table.Head class="text-muted-foreground">file</Table.Head>
						{#each view.model.fields as field (field.name)}
							{@const target = referenceTargetOf(field)}
							<Table.Head>
								<div class="flex flex-col gap-0.5">
									<span class="font-medium">{field.name}</span>
									{#if target}
										<span class="text-[10px] uppercase tracking-wide text-muted-foreground/70">
											→ {target}
										</span>
									{:else}
										<span class="text-[10px] uppercase tracking-wide text-muted-foreground/50">
											{field.kind}
										</span>
									{/if}
								</div>
							</Table.Head>
						{/each}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each view.conformance as conf (conf.row.fileName)}
						<Table.Row>
							<Table.Cell class="font-mono text-muted-foreground" title={conf.row.fileName}>
								{stemOf(conf.row.fileName)}
							</Table.Cell>
							{#each conf.cells as cell (cell.field.name)}
								{@const target = referenceTargetOf(cell.field)}
								<Table.Cell>
									{#if target}
										{@render relationCell(cellFor(table, conf.row.fileName, cell.field.name, target))}
									{:else}
										{@render valueCell(cell)}
									{/if}
								</Table.Cell>
							{/each}
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</section>
