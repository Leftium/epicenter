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
	import { withFileNewlines } from '$lib/files.js';
	import type { TodoEditor } from '$lib/todo-editor.svelte.js';
	import type { Todos } from '$lib/todos.svelte.js';
	import { confirmDelete } from './file-actions.js';
	import FileNameBar from './FileNameBar.svelte';
	import TodoStatus from './TodoStatus.svelte';

	let {
		todos,
		editor,
		onBack,
	}: {
		todos: Todos;
		editor: TodoEditor;
		/** Shown on narrow screens, where the list and the editor take turns. */
		onBack?: () => void;
	} = $props();

	/**
	 * The editor's draft, saved or not. The controls show its own values, not
	 * the validated ones, so a value that does not conform stays on screen.
	 */
	const current = $derived(editor.state);
	const title = $derived(
		typeof current.document.fields.title === 'string' ? current.document.fields.title : '',
	);
	const done = $derived(current.document.fields.done === true);
	const stem = $derived(rowStemOf(todos.folder.tables.todos.name, current.path) ?? '');
	let tab = $state('notes');

	async function editSource() {
		const problem = await todos.editSource(editor.path);
		if (problem) toast.error('Could not open the source', { description: problem });
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Todo">
	<div class="flex items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to todos" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		<Checkbox
			checked={done}
			aria-label="Done"
			onCheckedChange={(checked) => editor.change({ fields: { done: checked === true } })}
		/>
		<Input
			class="flex-1 text-base font-medium"
			value={title}
			placeholder="Title"
			aria-label="Title"
			oninput={(event) => {
				const control = event.currentTarget;
				// A refused change leaves the draft as it was; so does the control.
				if (editor.change({ fields: { title: control.value } }) !== undefined)
					control.value = title;
			}}
		/>
	</div>

	<TodoStatus {editor} onDiscard={() => void todos.discard(editor.path)} />

	{#if current.reading.issues.length > 0}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs">
			<p class="mb-1 flex items-center gap-2 font-medium">
				<Badge variant="destructive">Needs fixing</Badge>
				These fields are kept as typed, and the todo is not saved until they are fixed.
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each current.reading.issues as issue, index (index)}
					<li>{issue.message}</li>
				{/each}
			</ul>
		</div>
	{/if}

	<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
		<Tabs.List>
			<Tabs.Trigger value="notes">Notes</Tabs.Trigger>
			<Tabs.Trigger value="source">Source</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="notes" class="min-h-0 flex-1">
			<Textarea
				class="h-full min-h-40 resize-none font-sans"
				value={current.document.body}
				placeholder="Notes in Markdown"
				aria-label="Notes"
				oninput={(event) => {
					const control = event.currentTarget;
					const body = current.document.body;
					if (editor.change({ body: withFileNewlines(control.value, body) }) !== undefined)
						control.value = body;
				}}
			/>
		</Tabs.Content>
		<Tabs.Content value="source" class="flex min-h-0 flex-1 flex-col gap-2">
			<p class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				Saving writes this text, the whole file, in one standard form.
				<Button size="xs" variant="outline" onclick={() => void editSource()}>Edit source</Button>
			</p>
			<Textarea
				class="min-h-40 flex-1 resize-none font-mono text-xs"
				value={current.text}
				aria-label="Markdown source"
				readonly
				spellcheck={false}
			/>
		</Tabs.Content>
	</Tabs.Root>

	<FileNameBar
		prefix="todos/"
		name={stem}
		suffix=".md"
		onRename={(next) => todos.rename(editor.path, `${next}.md`)}
		onDelete={() => void confirmDelete(todos, editor.path)}
	/>
</section>
