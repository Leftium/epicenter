<!--
	Mounts the real TodoDetail as TodosView does: one instance, given the
	selected path's retained todo editor, and reused without a key as the
	selection moves between todos. "Hide detail" unmounts the whole view while
	the Todos owner keeps every editor, as the narrow layout's Back does.
-->
<script lang="ts">
	import type { Todos } from '$lib/todos.svelte.js';
	import TodoDetail from '../TodoDetail.svelte';

	let { todos }: { todos: Todos } = $props();
	const selection = $derived(todos.selection);
	let shown = $state(true);
</script>

<button type="button" data-host="toggle" onclick={() => (shown = !shown)}>
	{shown ? 'Hide detail' : 'Show detail'}
</button>
{#if !shown}
	<p data-view="hidden">The detail is hidden</p>
{:else if selection?.kind === 'todo'}
	<TodoDetail {todos} todo={selection.editor} />
{:else}
	<p data-view="no-todo">No todo is open</p>
{/if}
