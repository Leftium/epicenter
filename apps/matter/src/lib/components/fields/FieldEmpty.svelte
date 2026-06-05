<script lang="ts">
	import type { CellState } from '$lib/model/conformance';

	// The shared empty-cell indicator, used by every Field's non-editing empty
	// branch: a "required" badge when a non-nullable field is blank (NEEDS_VALUE),
	// or a muted placeholder when a nullable field is legitimately empty (EMPTY).
	let { state }: { state: CellState } = $props();
</script>

{#if state === 'NEEDS_VALUE'}
	<span
		class="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400"
		>required</span
	>
{:else}
	<span class="text-muted-foreground/40">·</span>
{/if}
