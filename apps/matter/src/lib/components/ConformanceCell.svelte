<script lang="ts">
	import type { CellResult } from '$lib/model/conformance';
	import type { DerivedKind } from '$lib/model/schema';

	// `derivedKind` (not `derived`) to avoid colliding with the `$derived` rune.
	let { cell, derivedKind }: { cell: CellResult; derivedKind: DerivedKind } =
		$props();
</script>

<!--
	The cell-state branches (EMPTY / NEEDS_VALUE / INVALID) come first and consume
	every non-OK value, so the kind branches below only ever see a value that
	already passed its schema. Those branches dispatch on `derivedKind.kind` ALONE
	(value-type guards are nested INSIDE, never `&&`-ed into the condition) so the
	chain narrows the `Kind` union exhaustively: the final `{:else}` asserts
	`kind satisfies never`, turning a new `Kind` with no render branch into a
	COMPILE error instead of a silent fallthrough to raw text. Adding a kind now
	forces both halves (match in schema.ts AND render here) to stay in lockstep.
-->
{#if cell.state === 'EMPTY'}
	<span class="text-muted-foreground/40">·</span>
{:else if cell.state === 'NEEDS_VALUE'}
	<span class="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
		required
	</span>
{:else if cell.state === 'INVALID'}
	<!-- Widget floor: an out-of-domain value drops to its JSON form + a badge so it
	     stays editable until it validates, then snaps back to the typed widget.
	     JSON (not String()) so the display matches the repair editor's seed and
	     keeps fidelity for arrays/objects (String(["a"]) = "a" is lossy). -->
	<code class="rounded bg-destructive/10 px-1 text-xs text-destructive">{JSON.stringify(cell.value)}</code>
{:else if derivedKind.kind === 'array'}
	{#if Array.isArray(cell.value)}
		<div class="flex flex-wrap gap-1">
			{#each cell.value as item, i (i)}
				<span class="rounded bg-muted px-1.5 py-0.5 text-xs">{item}</span>
			{/each}
		</div>
	{:else}
		<span class="truncate">{String(cell.value)}</span>
	{/if}
{:else if derivedKind.kind === 'boolean'}
	<span class={cell.value ? 'text-foreground' : 'text-muted-foreground'}>
		{cell.value ? '✓' : '✗'}
	</span>
{:else if derivedKind.kind === 'url'}
	{#if typeof cell.value === 'string'}
		<a href={cell.value} target="_blank" rel="noreferrer" class="text-primary underline underline-offset-2">
			{cell.value}
		</a>
	{:else}
		<span class="truncate">{String(cell.value)}</span>
	{/if}
{:else if derivedKind.kind === 'enum'}
	<span class="rounded bg-muted px-1.5 py-0.5 text-xs">{String(cell.value)}</span>
{:else if derivedKind.kind === 'number' || derivedKind.kind === 'integer'}
	<span class="tabular-nums">{String(cell.value)}</span>
{:else if derivedKind.kind === 'string' || derivedKind.kind === 'datetime' || derivedKind.kind === 'json'}
	<!-- The raw-text floor: `string` is the always-valid base, `datetime` shows its
	     ISO string until a typed DateCell lands (3.5), `json` is the read-only
	     fallback for unsupported shapes. -->
	<span class="truncate">{String(cell.value)}</span>
{:else}
	{@const _exhaustive = derivedKind.kind satisfies never}
	<span class="truncate">{String(cell.value)}</span>
{/if}
