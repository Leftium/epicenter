<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { rowStemOf } from '@epicenter/folder';
	import type { TextFileEditor } from '$lib/editor.svelte.js';
	import { withFileNewlines } from '$lib/files.js';
	import type { Todos } from '$lib/todos.svelte.js';
	import { confirmDelete } from './file-actions.js';
	import FileNameBar from './FileNameBar.svelte';
	import SaveStatus from './SaveStatus.svelte';

	let {
		todos,
		editor,
		reason,
		onBack,
	}: {
		todos: Todos;
		editor: TextFileEditor;
		/** Why the row did not open as fields, when its text alone does not show it. */
		reason: string | undefined;
		/** Shown on narrow screens, where the list and the editor take turns. */
		onBack?: () => void;
	} = $props();

	/**
	 * How the text on screen reads, by the table's own interpreter. Every
	 * diagnostic below describes this buffer, saved or not, and never the file
	 * as it was last saved.
	 */
	const draft = $derived(todos.folder.tables.todos.inspect(editor.buffer));
	const stem = $derived(rowStemOf(todos.folder.tables.todos.name, editor.path) ?? '');
	const title = $derived(
		typeof draft.fields.title === 'string' && draft.fields.title.trim() !== ''
			? draft.fields.title
			: editor.path,
	);

	async function editFields() {
		const problem = await todos.editFields(editor.path);
		if (problem) toast.error('Could not edit the fields', { description: problem });
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Todo source">
	<div class="flex items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to todos" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		<h2 class="min-w-0 flex-1 truncate text-base font-medium">{title}</h2>
		<Button size="sm" variant="outline" onclick={() => void editFields()}>Edit fields</Button>
	</div>

	<SaveStatus {editor} onDiscard={() => void todos.discard(editor.path)} />

	{#if draft.parseError}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				{draft.parseError.message}. Edit the source to fix it.
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
				Some fields need fixing before they can be edited as fields.
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each draft.issues as issue, index (index)}
					<li>{issue.message}</li>
				{/each}
			</ul>
		</div>
	{:else if reason}
		<p class="border-b bg-destructive/5 px-4 py-2 text-xs">{reason}</p>
	{/if}

	<div class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
		<Textarea
			class="min-h-40 flex-1 resize-none font-mono text-xs"
			value={editor.buffer}
			aria-label="Markdown source"
			spellcheck={false}
			oninput={(event) => editor.input(withFileNewlines(event.currentTarget.value, editor.buffer))}
		/>
	</div>

	<FileNameBar
		prefix="todos/"
		name={stem}
		suffix=".md"
		onRename={(next) => todos.rename(editor.path, `${next}.md`)}
		onDelete={() => void confirmDelete(todos, editor.path)}
	/>
</section>
