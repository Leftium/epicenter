<!--
	Mounts the real Detail as TodosView does: the detail pane for whatever the
	owner shows now, with each editor view keyed by its editor. "Hide detail"
	unmounts the whole pane while the Todos owner keeps every editor, as the
	narrow layout's Back does.
-->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { Todos } from '$lib/todos.svelte.js';
	import Detail from '../Detail.svelte';

	let { todos }: { todos: Todos } = $props();
	let shown = $state(true);
</script>

<button type="button" data-host="toggle" onclick={() => (shown = !shown)}>
	{shown ? 'Hide detail' : 'Show detail'}
</button>
<Tooltip.Provider>
	{#if shown}
		<Detail {todos} />
	{:else}
		<p data-view="hidden">The detail is hidden</p>
	{/if}
</Tooltip.Provider>
