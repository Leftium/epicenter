import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import {
	type Actions,
	attachActions,
	defineMutation,
	defineQuery,
} from '../shared/actions';
import { collectActionPaths, createActionsRouter } from './actions';

// Mock client for attaching actions
const mockClient = { id: 'test' };

describe('createActionsRouter', () => {
	test('creates routes for flat actions', async () => {
		const actions: Actions = {
			ping: defineQuery({
				handler: (_ctx) => 'pong',
			}),
		};
		const attached = attachActions(actions, mockClient);

		const app = createActionsRouter({ actions: attached });
		const response = await app.handle(new Request('http://test/actions/ping'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ data: 'pong' });
	});

	test('creates routes for nested actions', async () => {
		const actions: Actions = {
			posts: {
				list: defineQuery({
					handler: (_ctx) => ['post1', 'post2'],
				}),
			},
		};
		const attached = attachActions(actions, mockClient);

		const app = createActionsRouter({ actions: attached });
		const response = await app.handle(
			new Request('http://test/actions/posts/list'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ data: ['post1', 'post2'] });
	});

	test('query actions respond to GET requests', async () => {
		const actions: Actions = {
			getStatus: defineQuery({
				handler: (_ctx) => ({ status: 'ok' }),
			}),
		};
		const attached = attachActions(actions, mockClient);

		const app = createActionsRouter({ actions: attached });
		const response = await app.handle(
			new Request('http://test/actions/getStatus', { method: 'GET' }),
		);

		expect(response.status).toBe(200);
	});

	test('mutation actions respond to POST requests', async () => {
		let called = false;
		const actions: Actions = {
			doSomething: defineMutation({
				handler: (_ctx) => {
					called = true;
					return { done: true };
				},
			}),
		};
		const attached = attachActions(actions, mockClient);

		const app = createActionsRouter({ actions: attached });
		const response = await app.handle(
			new Request('http://test/actions/doSomething', { method: 'POST' }),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(called).toBe(true);
		expect(body).toEqual({ data: { done: true } });
	});

	test('mutation actions accept JSON body input', async () => {
		let capturedInput: unknown = null;
		const actions: Actions = {
			create: defineMutation({
				input: type({ title: 'string' }),
				handler: (_ctx, input) => {
					capturedInput = input;
					return { id: '123', title: input.title };
				},
			}),
		};
		const attached = attachActions(actions, mockClient);

		const app = createActionsRouter({ actions: attached });
		const response = await app.handle(
			new Request('http://test/actions/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Hello World' }),
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(capturedInput).toEqual({ title: 'Hello World' });
		expect(body).toEqual({ data: { id: '123', title: 'Hello World' } });
	});

	test('validates input and returns 422 for invalid data', async () => {
		const actions: Actions = {
			create: defineMutation({
				input: type({ title: 'string', count: 'number' }),
				handler: (_ctx, { title, count }) => ({ title, count }),
			}),
		};
		const attached = attachActions(actions, mockClient);

		const app = createActionsRouter({ actions: attached });
		const response = await app.handle(
			new Request('http://test/actions/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Hello', count: 'not-a-number' }),
			}),
		);

		expect(response.status).toBe(422);
	});

	test('async handlers work correctly', async () => {
		const actions: Actions = {
			asyncQuery: defineQuery({
				handler: async (_ctx) => {
					await new Promise((resolve) => setTimeout(resolve, 10));
					return { async: true };
				},
			}),
		};
		const attached = attachActions(actions, mockClient);

		const app = createActionsRouter({ actions: attached });
		const response = await app.handle(
			new Request('http://test/actions/asyncQuery'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ data: { async: true } });
	});

	test('supports custom base path', async () => {
		const actions: Actions = {
			test: defineQuery({
				handler: (_ctx) => 'ok',
			}),
		};
		const attached = attachActions(actions, mockClient);

		const app = createActionsRouter({ actions: attached, basePath: '/api' });
		const response = await app.handle(new Request('http://test/api/test'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ data: 'ok' });
	});

	test('deeply nested actions create correct routes', async () => {
		const actions: Actions = {
			api: {
				v1: {
					users: {
						list: defineQuery({
							handler: (_ctx) => [],
						}),
					},
				},
			},
		};
		const attached = attachActions(actions, mockClient);

		const app = createActionsRouter({ actions: attached });
		const response = await app.handle(
			new Request('http://test/actions/api/v1/users/list'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ data: [] });
	});
});

describe('collectActionPaths', () => {
	test('collects flat action paths', () => {
		const actions: Actions = {
			ping: defineQuery({ handler: (_ctx) => 'pong' }),
			sync: defineMutation({ handler: (_ctx) => {} }),
		};
		const attached = attachActions(actions, mockClient);

		const paths = collectActionPaths(attached);

		expect(paths).toContain('ping');
		expect(paths).toContain('sync');
		expect(paths).toHaveLength(2);
	});

	test('collects nested action paths', () => {
		const actions: Actions = {
			posts: {
				list: defineQuery({ handler: (_ctx) => [] }),
				create: defineMutation({ handler: (_ctx) => {} }),
			},
			users: {
				get: defineQuery({ handler: (_ctx) => null }),
			},
		};
		const attached = attachActions(actions, mockClient);

		const paths = collectActionPaths(attached);

		expect(paths).toContain('posts/list');
		expect(paths).toContain('posts/create');
		expect(paths).toContain('users/get');
		expect(paths).toHaveLength(3);
	});

	test('handles deeply nested actions', () => {
		const actions: Actions = {
			api: {
				v1: {
					users: {
						list: defineQuery({ handler: (_ctx) => [] }),
					},
				},
			},
		};
		const attached = attachActions(actions, mockClient);

		const paths = collectActionPaths(attached);

		expect(paths).toEqual(['api/v1/users/list']);
	});

	test('returns empty array for empty actions', () => {
		const paths = collectActionPaths({});

		expect(paths).toEqual([]);
	});
});
