<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import * as Dialog from '@epicenter/ui/dialog';
	import { Label } from '@epicenter/ui/label';
	import * as Separator from '@epicenter/ui/separator';
	import { Switch } from '@epicenter/ui/switch';
	import type { RowConformance } from '@epicenter/matter-core';
	import { editorPreferences } from '$lib/editor/editor-preferences.svelte';
	import MarkdownBodyEditor from './MarkdownBodyEditor.svelte';
	import ModeledCell from './ModeledCell.svelte';

	let {
		open = $bindable(false),
		conformance,
		onSaveField,
		onSaveBody,
	}: {
		open?: boolean;
		conformance: RowConformance;
		onSaveField: (fileName: string, key: string, value: unknown) => void;
		onSaveBody: (fileName: string, body: string) => void;
	} = $props();

	const row = $derived(conformance.row);
	const cellCounts = $derived.by(() => {
		const counts = { ok: 0, invalid: 0, missingRequired: 0 };
		for (const cell of conformance.cells) {
			if (cell.state === 'OK') counts.ok++;
			else if (cell.state === 'INVALID') counts.invalid++;
			else if (cell.state === 'MISSING_REQUIRED') counts.missingRequired++;
		}
		return counts;
	});

	function formatExtraValue(value: unknown): string {
		if (typeof value !== 'object') return String(value);
		return JSON.stringify(value) ?? '';
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="grid-rows-[auto_minmax(0,1fr)] h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-7xl gap-0 overflow-hidden p-0 sm:max-w-7xl"
	>
		<div class="border-b px-6 py-5">
			<Dialog.Header class="gap-3">
				<div class="flex flex-wrap items-start justify-between gap-4 pr-8">
					<div class="min-w-0 space-y-2">
						<Dialog.Title class="truncate font-mono text-xl leading-tight">
							{row.fileName}
						</Dialog.Title>
						<div class="flex flex-wrap gap-1.5">
							<Badge variant={conformance.rowValid ? 'secondary' : 'outline'}>
								{conformance.rowValid ? 'Ready' : 'Needs attention'}
							</Badge>
							<Badge variant="secondary">
								{cellCounts.ok} of {conformance.cells.length} fields filled
							</Badge>
							{#if cellCounts.missingRequired}
								<Badge
									class="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
									variant="outline"
								>
									{cellCounts.missingRequired} missing
								</Badge>
							{/if}
							{#if cellCounts.invalid}
								<Badge variant="destructive">{cellCounts.invalid} invalid</Badge>
							{/if}
							{#if conformance.extras.length}
								<Badge variant="outline">{conformance.extras.length} extra keys</Badge>
							{/if}
						</div>
					</div>
				</div>
			</Dialog.Header>
		</div>

		<div class="min-h-0 overflow-y-auto">
			<div class="mx-auto grid w-full max-w-6xl gap-8 px-6 py-7">
				<section class="grid gap-3">
					<div>
						<h2 class="text-sm font-semibold">Frontmatter</h2>
					</div>
					<div class="grid gap-2">
						{#each conformance.cells as cell (cell.field.name)}
							<div
								class="grid gap-3 rounded-md border bg-background px-3 py-3 sm:grid-cols-[11rem_1fr] sm:items-center"
								aria-invalid={cell.state === 'INVALID' || cell.state === 'MISSING_REQUIRED'}
							>
								<div class="min-w-0">
									<div class="truncate text-sm font-medium">{cell.field.name}</div>
									<div class="text-xs uppercase tracking-wide text-muted-foreground">
										{cell.field.kind}
									</div>
								</div>
								<div class="min-w-0">
									<ModeledCell
										{cell}
										mode="detail"
										save={(value) => onSaveField(row.fileName, cell.field.name, value)}
										clear={() => onSaveField(row.fileName, cell.field.name, undefined)}
									/>
								</div>
							</div>
						{/each}
					</div>
				</section>

				{#if conformance.extras.length}
					<section class="grid gap-3">
						<div>
							<h2 class="text-sm font-semibold">Extra keys</h2>
						</div>
						<div class="grid gap-2">
							{#each conformance.extras as extra (extra.key)}
								<div
									class="grid gap-3 rounded-md border bg-muted/20 px-3 py-2 sm:grid-cols-[11rem_1fr]"
								>
									<span class="truncate font-mono text-xs text-muted-foreground">
										{extra.key}
									</span>
									<code class="min-w-0 truncate text-xs">
										{formatExtraValue(extra.value)}
									</code>
								</div>
							{/each}
						</div>
					</section>
				{/if}

				<Separator.Root />

				<section class="grid gap-3">
					<div class="flex items-center justify-between gap-3">
						<h2 class="text-sm font-semibold">Body</h2>
						<div class="flex items-center gap-2">
							<Label for="matter-vim-mode" class="text-xs text-muted-foreground">Vim</Label>
							<Switch
								id="matter-vim-mode"
								size="sm"
								checked={editorPreferences.vimEnabled}
								onCheckedChange={(checked) => editorPreferences.setVimEnabled(checked)}
							/>
						</div>
					</div>
					{#key row.fileName}
						<!-- Keep teardown saves pointed at this keyed editor instance's row. -->
						{@const fileName = row.fileName}
						<MarkdownBodyEditor
							body={row.body}
							vimEnabled={editorPreferences.vimEnabled}
							onCommit={(body) => onSaveBody(fileName, body)}
						/>
					{/key}
				</section>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
