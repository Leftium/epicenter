<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Input } from '@epicenter/ui/input';
	import { Textarea } from '@epicenter/ui/textarea';
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import CirclePlusIcon from '@lucide/svelte/icons/circle-plus';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { todosState } from '$lib/todos/client';
	import type { Todo } from '../../todos';

	let title = $state('');
	let body = $state('');
	let contextName = $state('');

	function createTodo(event: SubmitEvent) {
		event.preventDefault();
		if (!title.trim()) return;
		todosState.createTodo({ title, body });
		title = '';
		body = '';
	}

	function createContext(event: SubmitEvent) {
		event.preventDefault();
		const name = contextName.trim();
		if (!name) return;
		todosState.createContext(name);
		contextName = '';
	}

	function formatDue(todo: Todo): string | null {
		if (todo.dueDate === null) return null;
		if (todo.dueTime === null) return todo.dueDate;
		return `${todo.dueDate} ${todo.dueTime}`;
	}
</script>

<main class="min-h-screen bg-background text-foreground">
	<div class="grid min-h-screen lg:grid-cols-[18rem_minmax(0,1fr)]">
		<aside class="border-border/70 border-b bg-muted/20 p-4 lg:border-r lg:border-b-0">
			<div class="mb-6 flex items-center gap-2">
				<div class="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
					<InboxIcon class="size-4" />
				</div>
				<div>
					<h1 class="text-base font-semibold">To-do's</h1>
					<p class="text-muted-foreground text-xs">epicenter.todos</p>
				</div>
			</div>

			<nav class="space-y-1">
				<Button
					variant={todosState.selectedContextId === null ? 'secondary' : 'ghost'}
					class="w-full justify-between"
					onclick={() => todosState.selectContext(null)}
				>
					<span>All</span>
					<Badge variant="outline">{todosState.openTodos.length}</Badge>
				</Button>
				{#each todosState.contexts as context (context.id)}
					<Button
						variant={todosState.selectedContextId === context.id ? 'secondary' : 'ghost'}
						class="w-full justify-between"
						onclick={() => todosState.selectContext(context.id)}
					>
						<span class="min-w-0 truncate">{context.name}</span>
						<Badge variant="outline">{todosState.contextCount(context.id)}</Badge>
					</Button>
				{/each}
			</nav>

			<form class="mt-6 flex gap-2" onsubmit={createContext}>
				<Input bind:value={contextName} placeholder="New context" />
				<Button type="submit" size="icon" tooltip="Add context">
					<CirclePlusIcon class="size-4" />
				</Button>
			</form>
		</aside>

		<section class="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
			<header class="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h2 class="text-2xl font-semibold tracking-normal">
						{todosState.selectedContextId
							? todosState.contextLabel(todosState.selectedContextId)
							: 'All open'}
					</h2>
					<p class="text-muted-foreground text-sm">
						{todosState.selectedOpenTodos.length} open, {todosState.selectedCompletedTodos.length} done
					</p>
				</div>
			</header>

			<form
				class="border-border bg-card grid gap-3 rounded-lg border p-3 shadow-sm sm:grid-cols-[minmax(0,1fr)_auto]"
				onsubmit={createTodo}
			>
				<div class="grid gap-2">
					<Input bind:value={title} placeholder="What needs to move?" />
					<Textarea bind:value={body} placeholder="Notes" class="min-h-20" />
				</div>
				<Button type="submit" class="self-start" disabled={!title.trim()}>
					<CirclePlusIcon class="size-4" />
					Add
				</Button>
			</form>

			<div class="grid gap-2">
				{#each todosState.selectedOpenTodos as todo (todo.id)}
					<article class="border-border bg-card rounded-lg border p-3 shadow-sm">
						<div class="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3">
							<Checkbox
								checked={false}
								onCheckedChange={(checked: boolean) =>
									todosState.toggleTodo(todo.id, checked === true)}
								aria-label={`Complete ${todo.title}`}
								class="mt-1"
							/>
							<div class="min-w-0">
								<div class="flex flex-wrap items-center gap-2">
									<h3 class="truncate text-sm font-medium">{todo.title}</h3>
									{#if formatDue(todo)}
										<Badge variant="secondary" class="gap-1">
											<CalendarIcon class="size-3" />
											{formatDue(todo)}
										</Badge>
									{/if}
								</div>
								{#if todo.body}
									<p class="text-muted-foreground mt-1 line-clamp-2 text-sm">
										{todo.body}
									</p>
								{/if}
								{#if todo.contexts.length > 0}
									<div class="mt-3 flex flex-wrap gap-1.5">
										{#each todo.contexts as slug (slug)}
											<Badge
												variant={todosState.contextFor(slug) ? 'secondary' : 'outline'}
											>
												{todosState.contextLabel(slug)}
											</Badge>
										{/each}
									</div>
								{/if}
							</div>
							<Button
								variant="ghost"
								size="icon-sm"
								tooltip="Delete todo"
								onclick={() => todosState.softDeleteTodo(todo.id)}
							>
								<Trash2Icon class="size-4" />
							</Button>
						</div>
					</article>
				{:else}
					<div class="border-border bg-card grid min-h-48 place-items-center rounded-lg border p-8 text-center">
						<div>
							<InboxIcon class="text-muted-foreground mx-auto mb-3 size-8" />
							<p class="text-sm font-medium">Nothing open</p>
						</div>
					</div>
				{/each}
			</div>
		</section>
	</div>
</main>
