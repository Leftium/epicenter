<!--
	The detail pane: what the person last opened, edited the way the surface
	they opened it from edits it. A todo from the list is its todo's fields and
	notes; a file from Files is its text. Each editor view is keyed by the
	editor it edits, so another editor, even at the same path, mounts a new
	view, and a view never changes owners. The editors live in the Todos
	owner, so this pane can unmount, as on narrow screens, without losing input.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { basename } from '@epicenter/folder/file-browser';
	import type { Todos } from '$lib/todos.svelte.js';
	import FileView from './FileView.svelte';
	import Handoff from './Handoff.svelte';
	import TodoDetail from './TodoDetail.svelte';

	let { todos, onBack }: { todos: Todos; onBack?: () => void } = $props();

	const current = $derived(todos.current);
</script>

{#snippet back()}
	{#if onBack}
		<Button variant="outline" size="sm" onclick={onBack}><ArrowLeftIcon /> Back to todos</Button>
	{/if}
{/snippet}

{#if current === undefined}
	<Empty.Root class="h-full">
		<Empty.Title>Select a todo to edit it</Empty.Title>
		<Empty.Description>Files opens any file, a todo's Markdown included, as text.</Empty.Description>
		{@render back()}
	</Empty.Root>
{:else if current.workspace === 'files'}
	{@const item = current.item}
	{#key item?.kind === 'text' ? item.editor : current.path}
		<FileView {todos} path={current.path} {item} {onBack} />
	{/key}
{:else if current.item?.kind === 'todo'}
	{#key current.item.editor}
		<TodoDetail {todos} todo={current.item.editor} {onBack} />
	{/key}
{:else if current.item?.kind === 'text'}
	{#key current.item.editor}
		<section class="flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Todo">
			<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
				{#if onBack}
					<Button variant="ghost" size="icon-sm" aria-label="Back to todos" onclick={onBack}>
						<ArrowLeftIcon />
					</Button>
				{/if}
				<h2 class="min-w-0 flex-1 truncate text-base font-medium">{basename(current.path)}</h2>
			</div>
			<Handoff {todos} path={current.path} item={current.item} to="todos" />
		</section>
	{/key}
{:else if current.item?.kind === 'loading'}
	<Loading class="h-full" label="Opening {basename(current.path)}…" />
{:else}
	<Empty.Root class="h-full">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		{#if current.item?.kind === 'failed'}
			<Empty.Title>Could not open this todo</Empty.Title>
			<Empty.Description>{current.item.message}</Empty.Description>
		{:else}
			<Empty.Title>{basename(current.path)} is no longer in the folder</Empty.Title>
			<Empty.Description>It was renamed or deleted outside this editor.</Empty.Description>
		{/if}
		<div class="flex flex-wrap justify-center gap-2">
			<Button variant="outline" size="sm" onclick={() => void todos.open(current.path, 'todos')}>Try again</Button>
			<Button variant="outline" size="sm" onclick={() => void todos.open(current.path, 'files')}>Open in Files</Button>
			{@render back()}
		</div>
	</Empty.Root>
{/if}
