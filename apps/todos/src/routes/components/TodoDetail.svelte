<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import * as Tabs from '@epicenter/ui/tabs';
	import { Textarea } from '@epicenter/ui/textarea';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { onDestroy } from 'svelte';
	import { rowStemOf } from '@epicenter/folder';
	import type { TodoEditor } from '$lib/todo-editor.svelte.js';
	import type { Todos } from '$lib/todos.svelte.js';
	import { confirmDelete } from './file-actions.js';
	import FileNameBar from './FileNameBar.svelte';
	import TodoStatus from './TodoStatus.svelte';

	let {
		todos,
		todo,
		onBack,
	}: {
		todos: Todos;
		/**
		 * The retained todo editor of the selected path. It owns the row and
		 * the source preference; this view only binds to it, so the same view
		 * showing another todo never carries input between them.
		 */
		todo: TodoEditor;
		/** Shown on narrow screens, where the list and the editor take turns. */
		onBack?: () => void;
	} = $props();

	// Every function binding below is a pair of closures that reads `todo` on
	// each call. Svelte evaluates a function binding's expressions once, when
	// its block is created; `bind:value={todo.title, todo.setTitle}` would keep
	// the first todo's methods after this view is reused for another todo.
	const stem = $derived(rowStemOf(todos.folder.tables.todos.name, todo.path) ?? '');
	const diagnostics = $derived(todo.diagnostics());
	let tab = $state('notes');

	/**
	 * Whether this view is mounted. A binding's input listener stays on a node
	 * after the view leaves the document, and the todo stays retained by the
	 * owner, so a delivered event could still reach its setter. Cleared as the
	 * view is destroyed; its setters and commands do nothing after that.
	 */
	const view = { mounted: true };
	onDestroy(() => {
		view.mounted = false;
	});

	/** Run a command of this view only while it is mounted. */
	function command(title: string, run: () => string | undefined) {
		if (!view.mounted) return;
		const problem = run();
		if (problem) toast.error(title, { description: problem });
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Todo">
	<div class="flex items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to todos" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		{#if todo.editor.row.status === 'valid' && !todo.rawMode}
			<Checkbox
				aria-label="Done"
				disabled={todo.isFenced}
				bind:checked={() => todo.done(), (done) => view.mounted && todo.setDone(done)}
			/>
			<Input
				class="flex-1 text-base font-medium"
				placeholder="Title"
				aria-label="Title"
				disabled={todo.isFenced}
				bind:value={() => todo.title(), (title) => view.mounted && todo.setTitle(title)}
			/>
		{:else}
			<h2 class="min-w-0 flex-1 truncate text-base font-medium">{stem === '' ? todo.path : stem}</h2>
			{#if todo.editor.row.status === 'valid'}
				<Button size="sm" variant="outline" onclick={() => command('Could not edit the fields', todo.editFields)}>
					Edit fields
				</Button>
			{/if}
		{/if}
	</div>

	<TodoStatus {todos} {todo} />

	{#if todo.editor.row.status === 'invalid' || todo.rawMode}
		{#if diagnostics}
			<div class="border-b bg-destructive/5 px-4 py-2 text-xs">
				<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					{diagnostics.summary} Edit the source to fix it.
				</p>
				<ul class="space-y-0.5 text-muted-foreground">
					{#each diagnostics.details as detail, index (index)}
						<li>{detail}</li>
					{/each}
				</ul>
			</div>
		{/if}
		<div class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-40 flex-1 resize-none font-mono text-xs"
				aria-label="Markdown source"
				spellcheck={false}
				disabled={todo.isFenced}
				bind:value={() => todo.text(), (text) => view.mounted && todo.setText(text)}
			/>
		</div>
	{:else}
		<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
			<Tabs.List>
				<Tabs.Trigger value="notes">Notes</Tabs.Trigger>
				<Tabs.Trigger value="source">Source</Tabs.Trigger>
			</Tabs.List>
			<Tabs.Content value="notes" class="min-h-0 flex-1">
				<Textarea
					class="h-full min-h-40 resize-none font-sans"
					placeholder="Notes in Markdown"
					aria-label="Notes"
					disabled={todo.isFenced}
					bind:value={() => todo.notes(), (notes) => view.mounted && todo.setNotes(notes)}
				/>
			</Tabs.Content>
			<Tabs.Content value="source" class="flex min-h-0 flex-1 flex-col gap-2">
				<p class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					Saving the fields writes this text, the whole file, in one standard form.
					<Button size="xs" variant="outline" onclick={() => command('Could not open the source', todo.editSource)}>
						Edit source
					</Button>
				</p>
				<Textarea
					class="min-h-40 flex-1 resize-none font-mono text-xs"
					value={todo.text()}
					aria-label="Markdown source preview"
					readonly
					spellcheck={false}
				/>
			</Tabs.Content>
		</Tabs.Root>
	{/if}

	<FileNameBar
		prefix="todos/"
		name={stem}
		suffix=".md"
		disabled={todos.departing}
		onRename={(next) => todos.rename(todo.path, `${next}.md`)}
		onDelete={() => void confirmDelete(todos, todo.path)}
	/>
</section>
