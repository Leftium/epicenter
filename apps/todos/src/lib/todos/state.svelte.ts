import type { CalendarDateString } from '@epicenter/field';
import { fromTable } from '@epicenter/svelte';
import {
	BUILT_IN_CONTEXT_IDS,
	BUILT_IN_CONTEXTS,
	type ContextSlug,
	type Todo,
	type TodoId,
} from '../../../todos';
import type { TodosBrowser } from '../../../todos.browser';

const builtInById = new Map(
	BUILT_IN_CONTEXTS.map((context) => [context.id, context]),
);

type TodosStateWorkspace = Pick<TodosBrowser, 'actions' | 'tables'>;

export function createTodosState(todos: TodosStateWorkspace) {
	const todosMap = fromTable(todos.tables.todos);
	const contextsMap = fromTable(todos.tables.contexts);
	let selectedContextId = $state<ContextSlug | null>(null);

	// Built-in contexts are always present and sort first; user-created rows
	// follow in their own sort order.
	const userContexts = $derived(
		[...contextsMap.values()]
			.filter((context) => !BUILT_IN_CONTEXT_IDS.has(context.id))
			.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
	);
	const contexts = $derived([...BUILT_IN_CONTEXTS, ...userContexts]);

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

	const inSelectedContext = (todo: Todo) =>
		selectedContextId === null || todo.contexts.includes(selectedContextId);

	const selectedOpenTodos = $derived(openTodos.filter(inSelectedContext));
	const selectedCompletedTodos = $derived(
		completedTodos.filter(inSelectedContext),
	);

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
			return builtInById.get(slug) ?? contextsMap.get(slug) ?? null;
		},
		contextLabel(slug: ContextSlug) {
			return (builtInById.get(slug) ?? contextsMap.get(slug))?.name ?? slug;
		},
		contextCount(slug: ContextSlug) {
			return openTodos.filter((todo) => todo.contexts.includes(slug)).length;
		},
		isBuiltInContext(slug: ContextSlug) {
			return BUILT_IN_CONTEXT_IDS.has(slug);
		},
		createTodo(input: {
			title: string;
			body: string;
			dueDate: CalendarDateString | null;
			contexts: ContextSlug[];
		}) {
			return todos.actions.todos_create({
				title: input.title,
				body: input.body,
				dueDate: input.dueDate,
				contexts: input.contexts,
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
		renameContext(slug: ContextSlug, name: string) {
			const trimmedName = name.trim();
			if (trimmedName === '') return;
			todos.actions.contexts_update({ slug, name: trimmedName });
		},
		deleteContext(slug: ContextSlug) {
			todos.actions.contexts_delete({ slug });
			if (selectedContextId === slug) selectedContextId = null;
		},
	};
}

function compareTodos(a: Todo, b: Todo): number {
	if (a.dueDate !== b.dueDate) {
		if (a.dueDate === null) return 1;
		if (b.dueDate === null) return -1;
		return a.dueDate.localeCompare(b.dueDate);
	}
	return a.createdAt.localeCompare(b.createdAt);
}
