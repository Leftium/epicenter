<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy } from 'svelte';
	import { Ok } from 'wellcrafted/result';
	import { openTodosFolder } from '#platform/folder';
	import { createTodos } from '$lib/todos.svelte.js';
	import TodosView from './components/TodosView.svelte';

	// The mounted page acquires the folder; importing modules opens nothing.
	// Which folder is the build's choice: a browser folder, or the desktop
	// host's directory. A folder that cannot be opened is shown as that
	// refusal; nothing else is opened in its place.
	const opening = openTodosFolder().then(async (opened) => {
		if (opened.error) return opened;
		const todos = createTodos(opened.data);
		await todos.refreshAll();
		return Ok(todos);
	});

	onDestroy(() => {
		void opening.then((opened) => opened.data?.close()).catch(() => {});
	});
</script>

{#snippet refused(message: string)}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Title>Could not open the todos folder</Empty.Title>
		<Empty.Description>{message}</Empty.Description>
	</Empty.Root>
{/snippet}

{#await opening}
	<Loading class="h-dvh" label="Opening your todos…" />
{:then opened}
	{#if opened.error}
		{@render refused(opened.error.message)}
	{:else}
		<TodosView todos={opened.data} />
	{/if}
{:catch error}
	{@render refused(error instanceof Error ? error.message : String(error))}
{/await}
