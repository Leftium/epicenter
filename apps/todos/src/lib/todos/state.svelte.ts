import { fromTable } from '@epicenter/svelte';
import type { ContextSlug, Todo, TodoId } from '../../../todos';
import type { TodosBrowser } from '../../../todos.browser';

const defaultContexts = [
	{ name: 'Phone', icon: 'phone', color: 'sky' },
	{ name: 'Desktop', icon: 'monitor', color: 'violet' },
	{ name: 'Home', icon: 'home', color: 'emerald' },
] as const;

export function createTodosState(todos: TodosBrowser) {
	const todosMap = fromTable(todos.tables.todos);
	const contextsMap = fromTable(todos.tables.contexts);
	let selectedContextId = $state<ContextSlug | null>(null);

	const contexts = $derived(
		[...contextsMap.values()].sort(
			(a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
		),
	);

	const notDeletedTodos = $derived(
		[...todosMap.values()]
			.filter((todo) => todo.deletedAt === null)
			.sort(compareTodos),
	);

	const openTodos = $derived(
		notDeletedTodos.filter((todo) => todo.completedAt === null),
	);

	const completedTodos = $derived(
		notDeletedTodos.filter((todo) => todo.completedAt !== null),
	);

	const selectedOpenTodos = $derived.by(() => {
		const contextId = selectedContextId;
		if (contextId === null) return openTodos;
		return openTodos.filter((todo) => todo.contexts.includes(contextId));
	});

	const selectedCompletedTodos = $derived.by(() => {
		const contextId = selectedContextId;
		if (contextId === null) return completedTodos;
		return completedTodos.filter((todo) => todo.contexts.includes(contextId));
	});

	return {
		[Symbol.dispose]() {
			todosMap[Symbol.dispose]();
			contextsMap[Symbol.dispose]();
		},
		get contexts() {
			return contexts;
		},
		get openTodos() {
			return openTodos;
		},
		get selectedOpenTodos() {
			return selectedOpenTodos;
		},
		get completedTodos() {
			return completedTodos;
		},
		get selectedCompletedTodos() {
			return selectedCompletedTodos;
		},
		get selectedContextId() {
			return selectedContextId;
		},
		selectContext(id: ContextSlug | null) {
			selectedContextId = id;
		},
		contextFor(slug: ContextSlug) {
			return contextsMap.get(slug) ?? null;
		},
		contextLabel(slug: ContextSlug) {
			return contextsMap.get(slug)?.name ?? slug;
		},
		contextCount(slug: ContextSlug) {
			return openTodos.filter((todo) => todo.contexts.includes(slug)).length;
		},
		ensureDefaultContexts() {
			if (contextsMap.size > 0) return;
			for (const context of defaultContexts) {
				todos.actions.contexts_create(context);
			}
		},
		createTodo(input: { title: string; body: string }) {
			return todos.actions.todos_create({
				title: input.title,
				body: input.body,
				contexts: selectedContextId ? [selectedContextId] : [],
			});
		},
		toggleTodo(id: TodoId, completed: boolean) {
			todos.actions.todos_set_completed({ id, completed });
		},
		softDeleteTodo(id: TodoId) {
			todos.actions.todos_delete({ id });
		},
		createContext(name: string) {
			const trimmedName = name.trim();
			if (trimmedName === '') return null;
			const id = todos.actions.contexts_create({ name: trimmedName });
			selectedContextId = id;
			return id;
		},
	};
}

function compareTodos(a: Todo, b: Todo): number {
	if (a.dueDate !== b.dueDate) {
		if (a.dueDate === null) return 1;
		if (b.dueDate === null) return -1;
		return a.dueDate.localeCompare(b.dueDate);
	}
	if (a.dueTime !== b.dueTime) {
		if (a.dueTime === null) return 1;
		if (b.dueTime === null) return -1;
		return a.dueTime.localeCompare(b.dueTime);
	}
	return a.createdAt.localeCompare(b.createdAt);
}
