import { describe, expect, test } from 'bun:test';
import { IanaTimeZone } from '@epicenter/workspace';
import {
	assertContextSlug,
	createTodos,
	generateContextSlug,
	parseDue,
	type TodoTimeString,
} from './todos';

const zone = 'America/Los_Angeles' as IanaTimeZone;

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

describe('due parsing', () => {
	test('parses none, all-day, and timed due states', () => {
		expect(
			parseDue({ dueDate: null, dueTime: null, dueZone: null }),
		).toEqual({ ok: true, due: { state: 'none' } });

		expect(
			parseDue({
				dueDate: '2026-06-14',
				dueTime: null,
				dueZone: null,
			}),
		).toEqual({ ok: true, due: { state: 'all-day', date: '2026-06-14' } });

		expect(
			parseDue({
				dueDate: '2026-06-14',
				dueTime: '09:30' as TodoTimeString,
				dueZone: zone,
			}),
		).toEqual({
			ok: true,
			due: {
				state: 'timed',
				date: '2026-06-14',
				time: '09:30',
				zone,
			},
		});
	});

	test('rejects impossible due states', () => {
		expect(
			parseDue({
				dueDate: null,
				dueTime: '09:30' as TodoTimeString,
				dueZone: zone,
			}).ok,
		).toBe(false);
		expect(
			parseDue({
				dueDate: '2026-06-14',
				dueTime: '09:30' as TodoTimeString,
				dueZone: null,
			}).ok,
		).toBe(false);
		expect(
			parseDue({
				dueDate: '2026-06-14',
				dueTime: null,
				dueZone: zone,
			}).ok,
		).toBe(false);
	});
});

describe('todo write path', () => {
	test('creates a context with a generated stable slug', () => {
		const todos = createTodos();
		expect(todos.actions.contexts_create({ name: 'Phone' })).toBe('phone');
		expect(todos.actions.contexts_create({ name: 'Phone' })).toBe('phone-2');
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
