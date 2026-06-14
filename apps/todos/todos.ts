import {
	CalendarDateString,
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
	IanaTimeZone,
	type InferTableRow,
	nullable,
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

export function assertContextSlug(value: string): ContextSlug {
	if (!isContextSlug(value)) {
		throw new Error(`Invalid context slug: ${value}`);
	}
	return value;
}

export function generateContextSlug(
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

export type TodoTimeString = string & Brand<'TodoTimeString'>;
const TODO_TIME_PATTERN = '^([01]\\d|2[0-3]):[0-5]\\d$';
const todoTimePattern = new RegExp(TODO_TIME_PATTERN);

function isTodoTimeString(value: unknown): value is TodoTimeString {
	return typeof value === 'string' && todoTimePattern.test(value);
}

const contextSlugSchema = Type.Unsafe<ContextSlug>(
	Type.String({ pattern: CONTEXT_SLUG_PATTERN }),
);

const todosTable = defineTable({
	id: field.string<TodoId>(),
	title: field.string({ minLength: 1 }),
	body: field.string(),
	dueDate: nullable(field.date()),
	dueTime: nullable(field.string<TodoTimeString>({ pattern: TODO_TIME_PATTERN })),
	dueZone: nullable(field.string<IanaTimeZone>()),
	contexts: field.json(Type.Array(contextSlugSchema)),
	completedAt: nullable(field.instant()),
	deletedAt: nullable(field.instant()),
	createdAt: field.instant(),
});
export type Todo = InferTableRow<typeof todosTable>;

const contextsTable = defineTable({
	id: field.string<ContextSlug>({ pattern: CONTEXT_SLUG_PATTERN }),
	name: field.string({ minLength: 1 }),
	icon: nullable(field.string()),
	color: nullable(field.string()),
	sortOrder: field.number(),
});
export type TodoContext = InferTableRow<typeof contextsTable>;

export type Due =
	| { state: 'none' }
	| { state: 'all-day'; date: CalendarDateString }
	| {
			state: 'timed';
			date: CalendarDateString;
			time: TodoTimeString;
			zone: IanaTimeZone;
	  };

export type DueParseResult =
	| { ok: true; due: Due }
	| { ok: false; reason: string };

type DueFields = Pick<Todo, 'dueDate' | 'dueTime' | 'dueZone'>;

export function parseDue(fields: DueFields): DueParseResult {
	const { dueDate, dueTime, dueZone } = fields;

	if (dueDate !== null && !CalendarDateString.is(dueDate)) {
		return { ok: false, reason: 'dueDate must be an ISO calendar date' };
	}
	if (dueTime !== null && !isTodoTimeString(dueTime)) {
		return { ok: false, reason: 'dueTime must be HH:mm' };
	}
	if (dueZone !== null && !IanaTimeZone.is(dueZone)) {
		return { ok: false, reason: 'dueZone must be an IANA timezone' };
	}

	if (dueDate === null && dueTime === null && dueZone === null) {
		return { ok: true, due: { state: 'none' } };
	}
	if (dueDate !== null && dueTime === null && dueZone === null) {
		return { ok: true, due: { state: 'all-day', date: dueDate } };
	}
	if (dueDate !== null && dueTime !== null && dueZone !== null) {
		return {
			ok: true,
			due: { state: 'timed', date: dueDate, time: dueTime, zone: dueZone },
		};
	}
	if (dueTime !== null && dueDate === null) {
		return { ok: false, reason: 'dueTime requires dueDate' };
	}
	return { ok: false, reason: 'dueTime and dueZone must exist together' };
}

function assertValidDue(fields: DueFields): Due {
	const parsed = parseDue(fields);
	if (!parsed.ok) throw new Error(parsed.reason);
	return parsed.due;
}

function normalizeContextSlugs(slugs: readonly string[]): ContextSlug[] {
	const unique = new Set<ContextSlug>();
	for (const slug of slugs) unique.add(assertContextSlug(slug));
	return [...unique];
}

type CreateTodoInput = {
	title: string;
	body?: string;
	dueDate?: CalendarDateString | null;
	dueTime?: TodoTimeString | null;
	dueZone?: IanaTimeZone | null;
	contexts?: readonly string[];
	createdAt?: InstantString;
};

function createTodoRow(input: CreateTodoInput): Todo {
	const title = input.title.trim();
	if (title === '') throw new Error('Todo title is required');
	const row: Todo = {
		id: generateTodoId(),
		title,
		body: input.body ?? '',
		dueDate: input.dueDate ?? null,
		dueTime: input.dueTime ?? null,
		dueZone: input.dueZone ?? null,
		contexts: normalizeContextSlugs(input.contexts ?? []),
		completedAt: null,
		deletedAt: null,
		createdAt: input.createdAt ?? InstantString.now(),
	};
	assertValidDue(row);
	return row;
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
					icon: Type.Optional(Type.String()),
					color: Type.Optional(Type.String()),
				}),
				handler: (input) => {
					const name = input.name.trim();
					if (name === '') throw new Error('Context name is required');
					const existing = tables.contexts.scan().rows;
					const id = generateContextSlug(
						name,
						existing.map((row) => row.id),
					);
					tables.contexts.set({
						id,
						name,
						icon: input.icon ?? null,
						color: input.color ?? null,
						sortOrder: existing.length,
					});
					return id;
				},
			}),
		}),
	});
}
