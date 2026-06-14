import {
	type CalendarDateString,
	field,
	InstantString,
} from '@epicenter/field';
import {
	createWorkspace,
	defineActions,
	defineMutation,
	defineTable,
	defineWorkspace,
	generateId,
	type InferTableRow,
	nullable,
	type Table,
} from '@epicenter/workspace';
import Type from 'typebox';
import type { Brand } from 'wellcrafted/brand';

export const TODOS_ID = 'epicenter-todos';

export type TodoId = string & Brand<'TodoId'>;
const generateTodoId = (): TodoId => generateId<TodoId>();

export type ContextSlug = string & Brand<'ContextSlug'>;
const CONTEXT_SLUG_PATTERN = '^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,47}$';

const contextSlugPattern = new RegExp(CONTEXT_SLUG_PATTERN);
const reservedContextSlugs = new Set([
	'false',
	'n',
	'no',
	'null',
	'off',
	'on',
	'true',
	'y',
	'yes',
]);

function isContextSlug(value: unknown): value is ContextSlug {
	return (
		typeof value === 'string' &&
		contextSlugPattern.test(value) &&
		!reservedContextSlugs.has(value)
	);
}

function assertContextSlug(value: string): ContextSlug {
	if (!isContextSlug(value)) {
		throw new Error(`Invalid context slug: ${value}`);
	}
	return value;
}

function generateContextSlug(
	name: string,
	existing: Iterable<string> = [],
): ContextSlug {
	const taken = new Set(existing);
	let base = name
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

	if (base === '') base = 'context';
	if (!/^[a-z]/.test(base)) base = `c-${base}`;
	if (reservedContextSlugs.has(base)) base = `context-${base}`;
	base = trimSlug(base);

	let candidate = base;
	let suffix = 2;
	while (taken.has(candidate) || !isContextSlug(candidate)) {
		const ending = `-${suffix}`;
		candidate = `${trimSlug(base, 48 - ending.length)}${ending}`;
		suffix += 1;
	}
	return candidate as ContextSlug;
}

function trimSlug(value: string, max = 48): string {
	return value.slice(0, max).replace(/-+$/g, '') || 'context';
}

/**
 * Deterministic context color palette. A context is assigned a color by its
 * creation order so every context (seeded or user-created) is visually
 * distinct without a color picker. The UI maps each token to a Tailwind class.
 */
const CONTEXT_COLORS = [
	'sky',
	'violet',
	'emerald',
	'amber',
	'rose',
	'cyan',
	'indigo',
	'lime',
] as const;

function pickContextColor(index: number): string {
	return CONTEXT_COLORS[index % CONTEXT_COLORS.length] ?? CONTEXT_COLORS[0];
}

const contextSlugSchema = Type.Unsafe<ContextSlug>(
	Type.String({ pattern: CONTEXT_SLUG_PATTERN }),
);

const todosTable = defineTable({
	id: field.string<TodoId>(),
	title: field.string({ minLength: 1 }),
	body: field.string(),
	dueDate: nullable(field.date()),
	contexts: field.json(Type.Array(contextSlugSchema)),
	completedAt: nullable(field.instant()),
	deletedAt: nullable(field.instant()),
	createdAt: field.instant(),
});
export type Todo = InferTableRow<typeof todosTable>;

const contextsTable = defineTable({
	id: field.string<ContextSlug>({ pattern: CONTEXT_SLUG_PATTERN }),
	name: field.string({ minLength: 1 }),
	color: nullable(field.string()),
	sortOrder: field.number(),
});
export type TodoContext = InferTableRow<typeof contextsTable>;

/**
 * Built-in contexts ship with every todos workspace as code constants, not
 * rows. They are always present, undeletable, and never written to the
 * contexts table; user-created contexts are rows layered on top. Their slugs
 * are reserved (see `contexts_create`) so a user context can never shadow a
 * built-in, and a todo may carry a built-in slug exactly like a row slug.
 */
export const BUILT_IN_CONTEXTS: readonly TodoContext[] = [
	{ id: 'phone' as ContextSlug, name: 'Phone', color: 'sky', sortOrder: 0 },
	{
		id: 'desktop' as ContextSlug,
		name: 'Desktop',
		color: 'violet',
		sortOrder: 1,
	},
	{ id: 'home' as ContextSlug, name: 'Home', color: 'emerald', sortOrder: 2 },
];

export const BUILT_IN_CONTEXT_IDS: ReadonlySet<ContextSlug> = new Set(
	BUILT_IN_CONTEXTS.map((context) => context.id),
);

function normalizeContextSlugs(slugs: readonly string[]): ContextSlug[] {
	const unique = new Set<ContextSlug>();
	for (const slug of slugs) unique.add(assertContextSlug(slug));
	return [...unique];
}

type CreateTodoInput = {
	title: string;
	body?: string;
	dueDate?: CalendarDateString | null;
	contexts?: readonly string[];
	createdAt?: InstantString;
};

function createTodoRow(input: CreateTodoInput): Todo {
	const title = input.title.trim();
	if (title === '') throw new Error('Todo title is required');
	return {
		id: generateTodoId(),
		title,
		body: input.body ?? '',
		dueDate: input.dueDate ?? null,
		contexts: normalizeContextSlugs(input.contexts ?? []),
		completedAt: null,
		deletedAt: null,
		createdAt: input.createdAt ?? InstantString.now(),
	};
}

/**
 * Delete a context and cascade-remove its slug from every todo. A todo that
 * still carries an unknown slug afterward (hand-edited file, mid-sync) renders
 * as a neutral chip rather than breaking.
 */
function deleteContext({
	tables,
	slug,
}: {
	tables: {
		contexts: Pick<Table<TodoContext>, 'get' | 'delete'>;
		todos: Pick<Table<Todo>, 'scan' | 'update'>;
	};
	slug: string;
}): { contextDeleted: boolean; todosUpdated: number } {
	const targetSlug = assertContextSlug(slug);
	const read = tables.contexts.get(targetSlug);
	if (read.error) throw read.error;
	if (read.data === null) return { contextDeleted: false, todosUpdated: 0 };

	tables.contexts.delete(targetSlug);

	let todosUpdated = 0;
	for (const todo of tables.todos.scan().rows) {
		if (!todo.contexts.includes(targetSlug)) continue;
		tables.todos.update(todo.id, {
			contexts: todo.contexts.filter((existing) => existing !== targetSlug),
		});
		todosUpdated += 1;
	}

	return { contextDeleted: true, todosUpdated };
}

export function createTodos() {
	const workspace = createWorkspace({
		id: TODOS_ID,
		tables: { todos: todosTable, contexts: contextsTable },
		kv: {},
	});
	const { tables } = workspace;

	return defineWorkspace({
		...workspace,
		actions: defineActions({
			todos_create: defineMutation({
				description: 'Create a todo',
				input: Type.Object({
					title: Type.String(),
					body: Type.Optional(Type.String()),
					dueDate: Type.Optional(Type.Union([field.date(), Type.Null()])),
					contexts: Type.Optional(Type.Array(contextSlugSchema)),
				}),
				handler: (input) => {
					const row = createTodoRow(input);
					tables.todos.set(row);
					return row.id;
				},
			}),
			todos_set_completed: defineMutation({
				description: 'Mark a todo complete or incomplete',
				input: Type.Object({
					id: Type.Unsafe<TodoId>(Type.String()),
					completed: Type.Boolean(),
				}),
				handler: (input) => {
					tables.todos.update(input.id, {
						completedAt: input.completed ? InstantString.now() : null,
					});
				},
			}),
			todos_delete: defineMutation({
				description: 'Soft-delete a todo',
				input: Type.Object({ id: Type.Unsafe<TodoId>(Type.String()) }),
				handler: (input) => {
					tables.todos.update(input.id, { deletedAt: InstantString.now() });
				},
			}),
			contexts_create: defineMutation({
				description: 'Create a context with a generated stable slug',
				input: Type.Object({
					name: Type.String(),
					color: Type.Optional(Type.String()),
				}),
				handler: (input) => {
					const name = input.name.trim();
					if (name === '') throw new Error('Context name is required');
					const existing = tables.contexts.scan().rows;
					const id = generateContextSlug(name, [
						...BUILT_IN_CONTEXT_IDS,
						...existing.map((row) => row.id),
					]);
					tables.contexts.set({
						id,
						name,
						color:
							input.color ??
							pickContextColor(BUILT_IN_CONTEXTS.length + existing.length),
						sortOrder: existing.length,
					});
					return id;
				},
			}),
			contexts_update: defineMutation({
				description: 'Edit a context label or color (slug unchanged)',
				input: Type.Object({
					slug: contextSlugSchema,
					name: Type.Optional(Type.String()),
					color: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				}),
				handler: (input) => {
					const read = tables.contexts.get(input.slug);
					if (read.error) throw read.error;
					const context = read.data;
					if (context === null) {
						throw new Error(`Context not found: ${input.slug}`);
					}
					const name =
						input.name === undefined ? context.name : input.name.trim();
					if (name === '') throw new Error('Context name is required');
					tables.contexts.set({
						...context,
						name,
						color: input.color === undefined ? context.color : input.color,
					});
				},
			}),
			contexts_delete: defineMutation({
				description: 'Delete a context and remove it from all todos',
				input: Type.Object({ slug: Type.String() }),
				handler: (input) =>
					workspace.ydoc.transact(() =>
						deleteContext({ tables, slug: input.slug }),
					),
			}),
		}),
	});
}
