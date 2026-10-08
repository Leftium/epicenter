<!--
	A path opened from one workspace while the other workspace's editor still
	holds the file. That editor is the file's one publisher here: it settles
	first, and only then does the new editor open. While it saves this says
	so; when its input could not be saved, the input stays with that editor,
	and this offers its own retry and discard choices, a copy of its text, a
	way back to it, and another try once it is saved. Nothing here reads the
	file again or claims the failed input was carried over.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { basename } from '@epicenter/folder/file-browser';
	import type { Retained, Todos, Workspace } from '$lib/todos.svelte.js';
	import Lifetime from './Lifetime.svelte';
	import SaveStatus from './SaveStatus.svelte';
	import TodoStatus from './TodoStatus.svelte';

	let {
		todos,
		path,
		item,
		to,
	}: {
		todos: Todos;
		path: string;
		/** The other workspace's editor, still retained at `path`. */
		item: Extract<Retained, { kind: 'todo' | 'text' }>;
		/** The workspace the person opened `path` from. */
		to: Workspace;
	} = $props();

	const from = $derived<Workspace>(item.kind === 'todo' ? 'todos' : 'files');
	const holder = $derived(from === 'todos' ? 'The todo list' : 'Files');

	async function copyText() {
		const text = item.kind === 'todo' ? item.editor.row.text : item.editor.buffer;
		try {
			await navigator.clipboard.writeText(text);
			toast.success(`Copied the text of ${basename(path)}`);
		} catch {
			toast.error('Could not copy the text', { description: path });
		}
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	{#if item.kind === 'todo'}
		<TodoStatus {todos} todo={item.editor} />
	{:else}
		{@const editor = item.editor}
		<!-- Discarding is the person's choice to let this input go; the open they asked for then proceeds. -->
		<SaveStatus
			{editor}
			onDiscard={() => {
				todos.discard(editor.path);
				void todos.open(path, to);
			}}
		/>
	{/if}
	<div class="space-y-3 px-4 py-4 text-sm" role="status">
		<p>
			{holder} still has {basename(path)} open. Its edits are saved before
			{to === 'files' ? 'Files opens its text' : 'the todo list opens it'}. Edits that
			could not be saved stay with it until you save or discard them.
		</p>
		<Lifetime>
			{#snippet children(live)}
				<div class="flex flex-wrap gap-2">
					<Button size="sm" onclick={() => live() && void todos.open(path, to)}>
						{to === 'files' ? 'Open its text' : 'Open as todo'}
					</Button>
					<Button size="sm" variant="outline" onclick={() => live() && void copyText()}>Copy text</Button>
					<Button size="sm" variant="ghost" onclick={() => live() && void todos.open(path, from)}>
						{from === 'todos' ? 'Back to the todo' : 'Back to Files'}
					</Button>
				</div>
			{/snippet}
		</Lifetime>
	</div>
</div>
