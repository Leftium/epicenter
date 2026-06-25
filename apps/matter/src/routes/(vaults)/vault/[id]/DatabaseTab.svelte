<script lang="ts">
	import { buildCreateTable } from '@epicenter/matter-core';
	import { Button } from '@epicenter/ui/button';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import type { VaultHandle } from '$lib/vault.svelte';

	// The "show the database" panel: the one honest surface that says matter IS a SQLite database. It
	// gives the db file path, a copyable `sqlite3` line to open it, and each typed table's CREATE TABLE
	// (the same DDL the projector emits), so a user or an agent can see exactly what SQL can query.
	let { vault }: { vault: VaultHandle } = $props();

	const dbPath = $derived(`${vault.root}/.matter/matter.sqlite`);
	const sqliteCommand = $derived(`sqlite3 "${dbPath}"`);

	// Each typed table's CREATE TABLE. An untyped folder has no projected table (no contract = no
	// columns), so it is skipped.
	const tableSchemas = $derived(
		vault.tables.flatMap((table) => {
			const view = table.read.view;
			if (view.mode !== 'typed') return [];
			return [
				{
					name: table.folderName,
					ddl: buildCreateTable(table.folderName, view.contract),
				},
			];
		}),
	);

	// Keyed by the copied text itself, so each Copy button reflects only its own click.
	let copied = $state<string>();
	let copiedTimeout: ReturnType<typeof setTimeout> | undefined;
	async function copy(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			return; // the text stays selectable; a clipboard denial is not worth surfacing
		}
		copied = text;
		clearTimeout(copiedTimeout);
		copiedTimeout = setTimeout(() => {
			copied = undefined;
		}, 1500);
	}

	// Clear the copied-state timer if the panel is torn down before it fires.
	$effect(() => () => clearTimeout(copiedTimeout));
</script>

{#snippet copyButton(text: string, variant: 'outline' | 'ghost')}
	<Button
		{variant}
		size="sm"
		class="h-8 shrink-0 gap-1.5 text-xs"
		onclick={() => copy(text)}
	>
		{#if copied === text}
			<CheckIcon class="size-3.5" />
			Copied
		{:else}
			<CopyIcon class="size-3.5" />
			Copy
		{/if}
	</Button>
{/snippet}

{#snippet copyRow(text: string)}
	<div class="flex items-center gap-2">
		<code
			class="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs"
		>
			{text}
		</code>
		{@render copyButton(text, 'outline')}
	</div>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col overflow-auto">
	<div class="border-b px-4 py-2">
		<h2 class="text-sm font-semibold">Database</h2>
		<p class="text-xs text-muted-foreground">
			{vault.folderName} is a SQLite database you (and your tools) can query directly. It is a
			read-only projection of the markdown on disk, rebuilt on every change.
		</p>
	</div>

	<div class="space-y-6 p-4">
		<section class="space-y-2">
			<h3
				class="text-xs font-medium uppercase tracking-wide text-muted-foreground"
			>
				Database file
			</h3>
			{@render copyRow(dbPath)}
			<p class="pt-1 text-xs text-muted-foreground">Open it in your terminal:</p>
			{@render copyRow(sqliteCommand)}
		</section>

		<section class="space-y-3">
			<h3
				class="text-xs font-medium uppercase tracking-wide text-muted-foreground"
			>
				Tables
			</h3>
			{#if tableSchemas.length === 0}
				<p class="text-sm text-muted-foreground">
					No typed tables yet. Add a matter.json with fields to project one.
				</p>
			{:else}
				{#each tableSchemas as schema (schema.name)}
					<div class="space-y-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="font-mono text-xs font-medium">{schema.name}</span>
							{@render copyButton(schema.ddl, 'ghost')}
						</div>
						<pre
							class="overflow-x-auto rounded-md border bg-muted/30 p-3 font-mono text-xs"><code
								>{schema.ddl}</code
							></pre>
					</div>
				{/each}
			{/if}
		</section>
	</div>
</div>
