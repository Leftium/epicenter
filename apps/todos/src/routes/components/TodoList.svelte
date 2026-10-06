<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { onDestroy } from 'svelte';
	import { needsRepair, type TodoEntry, type Todos } from '$lib/todos.svelte.js';

	let { todos, onOpen }: { todos: Todos; onOpen?: () => void } = $props();
	let adding = $state(false);
	/**
	 * Whether this list is mounted. The new todo's typed title belongs to the
	 * owner, which outlives the list on narrow screens; a field that left the
	 * document must not change it.
	 */
	const view = { mounted: true };
	onDestroy(() => {
		view.mounted = false;
	});

	function titleOf(entry: TodoEntry) {
		const title = entry.fields.title;
		if (typeof title === 'string' && title.trim() !== '') return title;
		// An empty stem (`todos/.md`) is a real address but not a readable label.
		return entry.stem === '' ? entry.path : entry.stem;
	}

	async function add(event: SubmitEvent) {
		event.preventDefault();
		if (!view.mounted) return;
		const title = todos.newTitle.trim();
		if (title === '' || adding) return;
		adding = true;
		// On success the owner clears the typed title itself.
		const problem = await todos.create(title);
		adding = false;
		if (problem) toast.error('Could not add the todo', { description: problem });
	}

	async function toggle(entry: TodoEntry) {
		const problem = await todos.toggle(entry);
		if (problem) toast.error('Could not change the todo', { description: problem });
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Todo list">
	<form class="flex shrink-0 items-center gap-2 border-b p-3" onsubmit={add}>
		<Input
			bind:value={() => todos.newTitle, (title) => view.mounted && (todos.newTitle = title)}
			placeholder="Add a todo"
			aria-label="New todo title"
			disabled={adding || todos.departing}
		/>
		<Button type="submit" disabled={adding || todos.departing || todos.newTitle.trim() === ''}>
			{adding ? 'Adding…' : 'Add'}
		</Button>
	</form>

	{#if todos.listError}
		<p class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive" role="status">
			Could not read the todos folder: {todos.listError}. Showing the last list that was read.
		</p>
	{/if}

	<ul class="min-h-0 flex-1 overflow-y-auto" aria-label="Todos">
		{#each todos.entries as entry (entry.path)}
			{@const selected = todos.selectedPath === entry.path}
			{@const done = entry.fields.done === true}
			<li
				class="flex items-center gap-2 border-b px-3 py-2 text-sm {selected
					? 'bg-accent text-accent-foreground'
					: ''}"
			>
				<Checkbox
					checked={done}
					disabled={typeof entry.fields.done !== 'boolean' || todos.departing}
					aria-label="{done ? 'Reopen' : 'Complete'} {titleOf(entry)}"
					onCheckedChange={() => void toggle(entry)}
				/>
				<Button
					variant="ghost"
					class="h-auto min-h-9 min-w-0 flex-1 justify-start whitespace-normal text-left"
					aria-current={selected ? 'true' : undefined}
					data-todo={entry.path}
					onclick={() => {
						void todos.open(entry.path);
						onOpen?.();
					}}
				>
					<span class="line-clamp-2 break-anywhere {done ? 'text-muted-foreground line-through' : ''}">{titleOf(entry)}</span>
					{#if needsRepair(entry)}
						<Badge variant="destructive" class="shrink-0">Needs repair</Badge>
					{/if}
				</Button>
			</li>
		{:else}
			<li>
				<Empty.Root>
					<Empty.Title>No todos yet</Empty.Title>
					<Empty.Description>Add your first todo above.</Empty.Description>
				</Empty.Root>
			</li>
		{/each}
	</ul>

	{#if todos.unreadable.length > 0}
		<div class="border-t bg-warning/10 px-3 py-2 text-xs">
			<p class="font-medium">Files that could not be read as text</p>
			<ul class="mt-1 space-y-0.5">
				{#each todos.unreadable as item (item.path)}
					<li><code class="font-mono">{item.path}</code>: {item.message}</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>
