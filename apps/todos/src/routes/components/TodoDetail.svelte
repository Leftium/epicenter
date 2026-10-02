<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Input } from '@epicenter/ui/input';
	import * as Tabs from '@epicenter/ui/tabs';
	import { Textarea } from '@epicenter/ui/textarea';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { patchTodo, type TodoEditor } from '$lib/editor.svelte.js';
	import { withFileNewlines } from '$lib/files.js';
	import type { Todos } from '$lib/todos.svelte.js';
	import { confirmDelete } from './file-actions.js';
	import FileNameBar from './FileNameBar.svelte';
	import SaveStatus from './SaveStatus.svelte';

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
	 * How the text on screen reads, by the table's own interpreter. Every
	 * control and every diagnostic below describes this buffer, saved or not,
	 * and never the file as it was last saved.
	 */
	const draft = $derived(todos.folder.tables.todos.inspect(editor.buffer));
	const title = $derived(draft.fields.title ?? '');
	const done = $derived(draft.fields.done === true);
	// A buffer that does not parse has no fields or body to edit; its source does.
	const structured = $derived(draft.parseError === undefined);
	let tab = $state('notes');
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
			disabled={!structured}
			aria-label="Done"
			onCheckedChange={(checked) => patchTodo(editor, { fields: { done: checked === true } })}
		/>
		<Input
			class="flex-1 text-base font-medium"
			value={title}
			placeholder="Title"
			aria-label="Title"
			disabled={!structured}
			oninput={(event) => patchTodo(editor, { fields: { title: event.currentTarget.value } })}
		/>
	</div>

	<SaveStatus {editor} onDiscard={() => todos.discard(editor.path)} />

	{#if draft.parseError}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				{draft.parseError.message}. Edit the source to fix it.
				{#if tab !== 'source'}
					<Button size="xs" variant="outline" onclick={() => (tab = 'source')}>Edit Source</Button>
				{/if}
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each draft.parseError.diagnostics as diagnostic, index (index)}
					{#if diagnostic.message !== draft.parseError.message}<li>{diagnostic.message}</li>{/if}
				{/each}
			</ul>
		</div>
	{:else if draft.issues.length > 0}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs">
			<p class="mb-1 flex items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				Some fields need fixing. The rest of the todo still works.
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each draft.issues as issue, index (index)}
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
				value={draft.body ?? ''}
				placeholder="Notes in Markdown"
				aria-label="Notes"
				disabled={!structured}
				oninput={(event) =>
					patchTodo(editor, { body: withFileNewlines(event.currentTarget.value, draft.body ?? '') })}
			/>
		</Tabs.Content>
		<Tabs.Content value="source" class="min-h-0 flex-1">
			<Textarea
				class="h-full min-h-40 resize-none font-mono text-xs"
				value={editor.buffer}
				aria-label="Markdown source"
				spellcheck={false}
				oninput={(event) => editor.input(withFileNewlines(event.currentTarget.value, editor.buffer))}
			/>
		</Tabs.Content>
	</Tabs.Root>

	<FileNameBar
		prefix="todos/"
		name={editor.baseline.stem}
		suffix=".md"
		onRename={(stem) => todos.rename(editor.path, `${stem}.md`)}
		onDelete={() => void confirmDelete(todos, editor.path)}
	/>
</section>
