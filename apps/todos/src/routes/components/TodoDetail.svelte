<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import * as Tabs from '@epicenter/ui/tabs';
	import { Textarea } from '@epicenter/ui/textarea';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { rowStemOf } from '@epicenter/folder';
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
		 * The retained todo editor of the selected path. It owns the row and
		 * the source preference; this view only binds to it, so the same view
		 * showing another todo never carries input between them.
		 */
		todo: TodoEditor;
		/** Shown on narrow screens, where the list and the editor take turns. */
		onBack?: () => void;
	} = $props();

	// Every function binding below reads `todo` on each call. Svelte evaluates
	// a function binding's expressions once, when its block is created, and
	// this view is reused as the selection moves; reading `todo` only then
	// would keep showing and writing the first todo.
	//
	// A binding's input listener stays on a node after its block leaves the
	// document, and the todo stays retained by the owner, so a delivered event
	// could still reach its setter. Each setter composes the complete row from
	// the todo's current row, and the todo refuses it unless that row still
	// shows its fields. Shared Input and Textarea retire destroyed value
	// bindings; Lifetime protects the checkbox and commands. Old controls stay
	// inert even after the same kind of block mounts again.
	const stem = $derived(rowStemOf(todos.folder.tables.todos.name, todo.path) ?? '');
	const diagnostics = $derived(todo.diagnostics());

	/** Textareas report LF, so views show LF; the todo restores the file's convention. */
	const lf = (text: string) => text.replace(/\r\n?/g, '\n');

</script>

<section class="flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Todo">
	<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to todos" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		{#if todo.row.status === 'valid' && !todo.rawMode}
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
							() => todo.row.status === 'valid' ? todo.refused.title?.value ?? todo.row.fields.title : '',
							(title) => {
								if (todo.row.status !== 'valid') return;
								todo.set({ ...todo.row, fields: { ...todo.row.fields, title } }, { control: 'title' });
							}
						}
					/>
				{/snippet}
			</Lifetime>
		{:else}
			<h2 class="min-w-0 flex-1 truncate text-base font-medium">{stem === '' ? todo.path : stem}</h2>
			{#if todo.row.status === 'valid'}
				<Lifetime>
					{#snippet children(live)}
						<Button size="sm" variant="outline" onclick={() => {
							if (!live()) return;
							const problem = todo.editFields();
							if (problem) toast.error('Could not edit the fields', { description: problem });
						}}>
							Edit fields
						</Button>
					{/snippet}
				</Lifetime>
			{/if}
		{/if}
	</div>

	<TodoStatus {todos} {todo} />

	{#if diagnostics}
		<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs">
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

	<Tabs.Root
		bind:value={
			() => todo.row.status === 'invalid' || todo.rawMode ? 'source' : 'notes',
			(next) => {
				const problem = next === 'source' ? todo.editSource() : todo.editFields();
				if (problem) toast.error('Could not change the editor view', { description: problem });
			}
		}
		class="flex min-h-48 flex-1 flex-col px-3 py-3 sm:px-4"
	>
		<Tabs.List>
			<Tabs.Trigger value="notes" disabled={todo.isFenced || todo.row.status !== 'valid'}>Notes</Tabs.Trigger>
			<Tabs.Trigger value="source" disabled={todo.isFenced}>Source</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="notes" class="flex min-h-0 flex-1 flex-col">
			{#if todo.row.status === 'valid'}
				<Textarea
					class="min-h-0 flex-1 field-sizing-fixed resize-none"
					placeholder="Notes in Markdown"
					aria-label="Notes"
					disabled={todo.isFenced}
					bind:value={
						() => todo.row.status === 'valid' ? todo.refused.notes?.value ?? lf(todo.row.body) : '',
						(notes) => {
							if (todo.row.status !== 'valid') return;
							todo.set({ ...todo.row, body: notes }, { control: 'notes' });
						}
					}
				/>
			{/if}
		</Tabs.Content>
		<Tabs.Content value="source" class="flex min-h-0 flex-1 flex-col gap-2">
			<Textarea
				class="min-h-0 flex-1 field-sizing-fixed resize-none font-mono text-xs"
				aria-label="Markdown source"
				spellcheck={false}
				disabled={todo.isFenced}
				bind:value={() => lf(todo.row.text), (text) => todo.setText(text)}
			/>
		</Tabs.Content>
	</Tabs.Root>

	<FileNameBar
		prefix="todos/"
		name={stem}
		suffix=".md"
		disabled={todos.departing}
		onRename={(next) => todos.rename(todo.path, `${next}.md`)}
		onDelete={() => void confirmDelete(todos, todo.path)}
	/>
</section>
