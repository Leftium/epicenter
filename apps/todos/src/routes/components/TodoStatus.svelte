<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { onDestroy } from 'svelte';
	import { describeSaveError, type TodoEditor } from '$lib/todo-editor.svelte.js';
	import type { Todos } from '$lib/todos.svelte.js';

	let { todos, todo }: { todos: Todos; todo: TodoEditor } = $props();

	/** Whether this status is mounted; its buttons act for a mounted view only. */
	const status = { mounted: true };
	onDestroy(() => {
		status.mounted = false;
	});

	function retry() {
		if (!status.mounted) return;
		const problem = todo.retry();
		if (problem) toast.error('Could not save the todo', { description: problem });
	}

	/** The owner's last error remains visible while a newer write runs. */
	const failure = $derived('error' in todo.editor.save ? todo.editor.save.error : undefined);

	async function reload() {
		if (!status.mounted) return;
		const problem = await todos.reload(todo.path);
		if (problem) toast.error('Could not reload the todo', { description: problem });
	}
</script>

<!-- One todo's save state, and the choices that settle a write that did not finish. -->
<div class="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs">
	{#if todo.isFenced}
		<span class="text-muted-foreground">Working on this file…</span>
	{:else if todo.editor.save.status === 'saving'}
		<span class="text-muted-foreground">Saving…</span>
		{#if failure}
			<span class="w-full text-destructive" role="alert">{describeSaveError(failure)} Your latest edit is being saved.</span>
		{/if}
	{:else if todo.editor.save.status === 'failed'}
		<!-- An unconfirmed save may have landed: its message says so, and keeps the folder's own detail. -->
		<span class="w-full text-destructive" role="alert">
			{describeSaveError(todo.editor.save.error)} Your edits stay here. Your next edit saves again, or you can save them again without changing them.
			{todo.refusals.join(' ')}
		</span>
		{#if todo.editor.save.error.name === 'NotFound'}
			<Button size="xs" variant="outline" onclick={() => { if (status.mounted) todos.discard(todo.path); }}>Close</Button>
		{:else}
			<Button size="xs" onclick={retry}>
				{todo.editor.save.error.name === 'Unconfirmed' ? 'Save again' : 'Try again'}
			</Button>
			<Button size="xs" variant="outline" onclick={reload}>Discard mine and reload</Button>
		{/if}
	{:else if todo.refusals.length > 0}
		<!-- The refused value stays in its field for correction; the rest of the todo saves as usual. -->
		<span class="w-full text-destructive" role="alert">
			{todo.refusals.join(' ')} Your typing stays in the field until you fix it.
		</span>
		<Button size="xs" variant="outline" onclick={reload}>Discard mine and reload</Button>
	{:else}
		<span class="text-muted-foreground">Saved to <code class="font-mono">{todo.path}</code></span>
		<Button size="xs" variant="ghost" onclick={reload}>Reload</Button>
	{/if}
</div>
