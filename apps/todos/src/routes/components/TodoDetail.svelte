<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Input } from '@epicenter/ui/input';
	import { Textarea } from '@epicenter/ui/textarea';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { rowStemOf } from '@epicenter/folder';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import type { TodoEditor } from '$lib/todo-editor.svelte.js';
	import type { Todos } from '$lib/todos.svelte.js';
	import { confirmDelete } from './file-actions.js';
	import FileNameBar from './FileNameBar.svelte';
	import Lifetime from './Lifetime.svelte';
	import TodoStatus from './TodoStatus.svelte';

	let {
		todos,
		todo,
		onBack,
	}: {
		todos: Todos;
		/**
		 * The todo editor this view edits for its whole lifetime. The parent
		 * keys the view by it, so another todo, or a new editor at the same
		 * path, mounts a new view. The owner retains the editor and its input
		 * after the view leaves.
		 */
		todo: TodoEditor;
		/** Shown on narrow screens, where the list and the editor take turns. */
		onBack?: () => void;
	} = $props();

	// Each setter reads `todo.row` at the event, never a render-time copy, and
	// composes the complete row from it. A row that no longer reads as a todo
	// has no fields to compose from, so its controls are gone and their
	// setters return. Shared Input and Textarea retire destroyed bindings;
	// Lifetime retires the checkbox and the Files button. A released editor
	// refuses whatever still reaches it.
	const stem = $derived(rowStemOf(todos.folder.tables.todos.name, todo.path) ?? '');
	const diagnostics = $derived(todo.diagnostics());

	/** Textareas report LF, so views show LF; the notes setter restores the file's convention. */
	const lf = (text: string) => text.replace(/\r\n?/g, '\n');
</script>

<section class="flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Todo">
	<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to todos" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		{#if todo.row.status === 'valid'}
			<!-- Its own lifetime: a checkbox left over from before the row was invalid stays inert when the fields return. -->
			<Lifetime>
				{#snippet children(live)}
					<Checkbox
						aria-label="Done"
						disabled={todo.isFenced}
						bind:checked={
							() => todo.row.status === 'valid' && todo.row.fields.done,
							(done) => {
								if (!live() || todo.row.status !== 'valid') return;
								todo.set({ ...todo.row, fields: { ...todo.row.fields, done } });
							}
						}
					/>
					<Input
						class="flex-1 text-base font-medium"
						placeholder="Title"
						aria-label="Title"
						disabled={todo.isFenced}
						bind:value={
							() => (todo.row.status === 'valid' ? todo.row.fields.title : ''),
							(title) => {
								if (todo.row.status !== 'valid') return;
								todo.set({ ...todo.row, fields: { ...todo.row.fields, title } });
							}
						}
					/>
				{/snippet}
			</Lifetime>
		{:else}
			<h2 class="min-w-0 flex-1 truncate text-base font-medium">{stem === '' ? todo.path : stem}</h2>
		{/if}
		<!-- Navigation, not a mode: the todo settles and is let go before Files opens its text. -->
		<Lifetime>
			{#snippet children(live)}
				<Button size="sm" variant="outline" onclick={() => live() && void todos.open(todo.path, 'files')}>
					Open in Files
				</Button>
			{/snippet}
		</Lifetime>
	</div>

	<TodoStatus {todos} {todo} />

	{#if diagnostics}
		<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				{diagnostics.summary} Open it in Files to repair its text.
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each diagnostics.details as detail, index (index)}
					<li>{detail}</li>
				{/each}
			</ul>
		</div>
	{:else}
		<div class="flex min-h-48 flex-1 flex-col px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-0 flex-1 field-sizing-fixed resize-none"
				placeholder="Notes in Markdown"
				aria-label="Notes"
				disabled={todo.isFenced}
				bind:value={
					() => (todo.row.status === 'valid' ? lf(todo.row.body) : ''),
					(notes) => {
						if (todo.row.status !== 'valid') return;
						todo.set({ ...todo.row, body: withFileNewlines(notes, todo.row.text) });
					}
				}
			/>
		</div>
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
