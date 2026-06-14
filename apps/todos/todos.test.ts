import { describe, expect, test } from 'bun:test';
import type { CalendarDateString } from '@epicenter/field';
import {
	assertContextSlug,
	BUILT_IN_CONTEXTS,
	createTodos,
	generateContextSlug,
} from './todos';

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
		expect(assertContextSlug('phone')).toBe('phone');
		expect(assertContextSlug('on-the-go')).toBe('on-the-go');
	});

	test('rejects YAML-sensitive and unstable slugs', () => {
		expect(() => assertContextSlug('no')).toThrow();
		expect(() => assertContextSlug('Phone')).toThrow();
		expect(() => assertContextSlug('phone-')).toThrow();
		expect(() => assertContextSlug('phone--home')).toThrow();
	});

	test('generates deterministic non-colliding slugs', () => {
		expect(generateContextSlug('Phone', ['phone'])).toBe('phone-2');
		expect(generateContextSlug('2026 Planning')).toBe('c-2026-planning');
		expect(generateContextSlug('No')).toBe('context-no');
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
	test('creates a context with a generated stable slug', () => {
		const todos = createTodos();
		expect(todos.actions.contexts_create({ name: 'Errands' })).toBe('errands');
		expect(todos.actions.contexts_create({ name: 'Errands' })).toBe(
			'errands-2',
		);
	});

	test('a user context cannot shadow a built-in slug', () => {
		const todos = createTodos();
		// "Phone" is a built-in, so the row gets a disambiguated slug instead.
		expect(todos.actions.contexts_create({ name: 'Phone' })).toBe('phone-2');
	});

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
			'desktop',
			'home',
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

	test('a built-in slug cannot be the target of a slug rename', () => {
		const todos = createTodos();
		const slug = todos.actions.contexts_create({ name: 'Errands' });
		expect(() =>
			todos.actions.contexts_rename_slug({ from: slug, to: 'phone' }),
		).toThrow();
	});
});

describe('context management', () => {
	test('renaming the label leaves the slug and todos untouched', () => {
		const { todos, slug, id } = seededTodo();

		todos.actions.contexts_update({ slug, name: 'Mobile' });

		expect(todos.tables.contexts.get(slug).data?.name).toBe('Mobile');
		expect(todos.tables.todos.get(id).data?.contexts).toEqual([slug]);
	});

	test('renaming the slug migrates todo references', () => {
		const { todos, slug, id } = seededTodo();

		const result = todos.actions.contexts_rename_slug({
			from: slug,
			to: 'mobile',
		});

		expect(result).toEqual({ contextRenamed: true, todosUpdated: 1 });
		expect(todos.tables.contexts.get('mobile').data?.name).toBe('Phone');
		expect(todos.tables.contexts.get(slug).data).toBeNull();
		expect(todos.tables.todos.get(id).data?.contexts).toEqual(['mobile']);
	});

	test('deleting a context cascades removal from todos', () => {
		const { todos, slug, id } = seededTodo();

		const result = todos.actions.contexts_delete({ slug });

		expect(result).toEqual({ contextDeleted: true, todosUpdated: 1 });
		expect(todos.tables.contexts.get(slug).data).toBeNull();
		expect(todos.tables.todos.get(id).data?.contexts).toEqual([]);
	});
});
