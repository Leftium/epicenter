/**
 * Todos Workspace Tests
 *
 * Verifies todo and context domain behavior across the workspace actions and
 * the app shell's persisted model.
 *
 * Key behaviors:
 * - Context slugs are stable, valid, and collision-resistant
 * - Built-in contexts are code constants layered over user rows
 * - Context label edits preserve slugs, while deletes remove todo references
 */
import { describe, expect, test } from 'bun:test';
import type { CalendarDateString } from '@epicenter/field';
import { BUILT_IN_CONTEXTS, createTodos } from './todos';

function seededTodo(name = 'Phone') {
	const todos = createTodos();
	const slug = todos.actions.contexts_create({ name });
	const id = todos.actions.todos_create({
		title: 'Call back',
		contexts: [slug],
	});
	return { todos, slug, id };
}

describe('context slugs', () => {
	test('accepts stable file-facing slugs', () => {
		const todos = createTodos();
		const id = todos.actions.todos_create({
			title: 'Grouped',
			contexts: ['phone', 'on-the-go'],
		});

		expect(todos.tables.todos.get(id).data?.contexts).toEqual([
			'phone',
			'on-the-go',
		]);
	});

	test('rejects YAML-sensitive and unstable slugs', () => {
		const todos = createTodos();
		expect(() =>
			todos.actions.todos_create({ title: 'Nope', contexts: ['no'] }),
		).toThrow();
		expect(() =>
			todos.actions.todos_create({ title: 'Nope', contexts: ['Phone'] }),
		).toThrow();
		expect(() =>
			todos.actions.todos_create({ title: 'Nope', contexts: ['phone-'] }),
		).toThrow();
		expect(() =>
			todos.actions.todos_create({ title: 'Nope', contexts: ['phone--home'] }),
		).toThrow();
	});

	test('generates deterministic non-colliding slugs', () => {
		const todos = createTodos();

		expect(todos.actions.contexts_create({ name: 'Phone' })).toBe('phone-2');
		expect(todos.actions.contexts_create({ name: 'Computer' })).toBe(
			'computer-2',
		);
		expect(todos.actions.contexts_create({ name: 'Desk' })).toBe('desk-2');
		expect(todos.actions.contexts_create({ name: 'Errands' })).toBe('errands');
		expect(todos.actions.contexts_create({ name: 'Errands' })).toBe(
			'errands-2',
		);
		expect(todos.actions.contexts_create({ name: '2026 Planning' })).toBe(
			'c-2026-planning',
		);
		expect(todos.actions.contexts_create({ name: 'No' })).toBe('context-no');
	});
});

describe('due dates', () => {
	test('a todo has no due date by default', () => {
		const todos = createTodos();
		const id = todos.actions.todos_create({ title: 'Someday' });
		expect(todos.tables.todos.get(id).data?.dueDate).toBeNull();
	});

	test('an all-day due date round-trips through create', () => {
		const todos = createTodos();
		const id = todos.actions.todos_create({
			title: 'Pay rent',
			dueDate: '2026-07-01' as CalendarDateString,
		});
		expect(todos.tables.todos.get(id).data?.dueDate).toBe('2026-07-01');
	});
});

describe('todo write path', () => {
	test('auto-assigns a distinct color per context', () => {
		const todos = createTodos();
		const a = todos.actions.contexts_create({ name: 'Phone' });
		const b = todos.actions.contexts_create({ name: 'Home' });
		const colorA = todos.tables.contexts.get(a).data?.color;
		const colorB = todos.tables.contexts.get(b).data?.color;
		expect(colorA).not.toBeNull();
		expect(colorA).not.toBe(colorB);
	});

	test('creates, completes, and soft-deletes a todo through actions', () => {
		const todos = createTodos();
		const slug = todos.actions.contexts_create({ name: 'Phone' });

		const id = todos.actions.todos_create({
			title: 'Reply from mobile',
			contexts: [slug],
		});
		const created = todos.tables.todos.get(id).data;
		expect(created?.title).toBe('Reply from mobile');
		expect(created?.contexts).toEqual([slug]);
		expect(created?.completedAt).toBeNull();

		todos.actions.todos_set_completed({ id, completed: true });
		expect(todos.tables.todos.get(id).data?.completedAt).not.toBeNull();

		todos.actions.todos_delete({ id });
		expect(todos.tables.todos.get(id).data?.deletedAt).not.toBeNull();
	});
});

describe('built-in contexts', () => {
	test('ship as constants, not seeded rows', () => {
		const todos = createTodos();
		expect(BUILT_IN_CONTEXTS.map((context) => context.id)).toEqual([
			'phone',
			'computer',
			'desk',
		]);
		// They are code constants: the contexts table starts empty.
		expect(todos.tables.contexts.scan().rows).toEqual([]);
	});

	test('a todo can carry a built-in slug', () => {
		const todos = createTodos();
		const id = todos.actions.todos_create({
			title: 'Text back',
			contexts: ['phone'],
		});
		expect(todos.tables.todos.get(id).data?.contexts).toEqual(['phone']);
	});
});

describe('context management', () => {
	test('renaming the label leaves the slug and todos untouched', () => {
		const { todos, slug, id } = seededTodo();

		todos.actions.contexts_update({ slug, name: 'Mobile' });

		expect(todos.tables.contexts.get(slug).data?.name).toBe('Mobile');
		expect(todos.tables.todos.get(id).data?.contexts).toEqual([slug]);
	});

	test('deleting a context cascades removal from todos', () => {
		const { todos, slug, id } = seededTodo();

		const result = todos.actions.contexts_delete({ slug });

		expect(result).toEqual({ contextDeleted: true, todosUpdated: 1 });
		expect(todos.tables.contexts.get(slug).data).toBeNull();
		expect(todos.tables.todos.get(id).data?.contexts).toEqual([]);
	});
});
