<script lang="ts">
	import type { Extra } from '$lib/model/conformance';
	import type { Row } from '$lib/model/types';

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

<div class="flex flex-col gap-3 px-2 py-2">
	<label class="flex flex-col gap-1 text-xs">
		<span class="text-muted-foreground">Body</span>
		<textarea
			bind:value={draft}
			onblur={commit}
			rows={Math.min(12, Math.max(3, draft.split('\n').length))}
			class="w-full resize-y rounded border bg-background px-2 py-1 font-mono text-xs"
			placeholder="(empty)"
		></textarea>
	</label>

	{#if extras.length}
		<div class="flex flex-col gap-1 text-xs">
			<span class="text-muted-foreground">Unmodeled keys (preserved, not validated):</span>
			{#each extras as extra (extra.key)}
				<div class="font-mono">
					<span class="text-muted-foreground">{extra.key}:</span>
					{typeof extra.value === 'object'
						? JSON.stringify(extra.value)
						: String(extra.value)}
				</div>
			{/each}
		</div>
	{/if}
</div>
