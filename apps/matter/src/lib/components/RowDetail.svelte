<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Textarea } from '@epicenter/ui/textarea';
	import type { Extra } from '$lib/core/conformance';
	import type { Row } from '$lib/core/parse';

	let {
		row,
		extras,
		onSaveBody,
	}: {
		row: Row;
		extras: Extra[];
		onSaveBody: (name: string, body: string) => void;
	} = $props();

	// Local draft so an echo delta (the row re-rendering after a save lands) never
	// stomps an in-progress body edit. Seeding from `row.body` ONCE is the point:
	// the panel is keyed by row name, so reopening re-seeds, but a live edit is not
	// overwritten mid-type. Committed on blur.
	// svelte-ignore state_referenced_locally
	let draft = $state(row.body);

	function commit() {
		if (draft !== row.body) onSaveBody(row.name, draft);
	}
</script>

<div class="grid gap-4 bg-muted/20 px-3 py-3">
	<label class="grid gap-1.5 text-xs">
		<span class="font-medium text-muted-foreground">Body</span>
		<Textarea
			bind:value={draft}
			onblur={commit}
			rows={Math.min(12, Math.max(3, draft.split('\n').length))}
			class="min-h-20 resize-y bg-background font-mono text-xs"
			placeholder="(empty)"
		/>
	</label>

	{#if extras.length}
		<div class="grid gap-2 text-xs">
			<div class="flex items-center gap-2">
				<span class="font-medium text-muted-foreground">Unmodeled keys</span>
				<Badge variant="secondary">{extras.length}</Badge>
			</div>
			<div class="grid gap-1.5">
				{#each extras as extra (extra.key)}
					<div
						class="grid grid-cols-[minmax(7rem,12rem)_1fr] gap-2 rounded-md border bg-background px-2 py-1.5"
					>
						<span class="truncate font-mono text-muted-foreground">{extra.key}</span>
						<code class="truncate text-xs">
							{typeof extra.value === 'object'
								? JSON.stringify(extra.value)
								: String(extra.value)}
						</code>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
