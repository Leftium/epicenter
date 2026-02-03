import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import {
	type Actions,
	attachActions,
	defineMutation,
	defineQuery,
} from '../shared/actions';
import { buildActionCommands } from './command-builder';

// Mock client for attaching actions
const mockClient = { id: 'test' };

describe('buildActionCommands', () => {
	test('builds command from simple action without input', () => {
		const actions: Actions = {
			getAll: defineQuery({
				handler: (_ctx) => [],
			}),
		};
		const attached = attachActions(actions, mockClient);

		const commands = buildActionCommands(attached);

		expect(commands).toHaveLength(1);
		expect(commands[0]?.command).toBe('getAll');
		expect(commands[0]?.describe).toBe('Query: getAll');
		expect(commands[0]?.builder).toEqual({});
		expect(typeof commands[0]?.handler).toBe('function');
	});

	test('builds command from action with input schema', () => {
		const actions: Actions = {
			create: defineMutation({
				input: type({ title: 'string' }),
				handler: (_ctx, { title }) => ({ id: '1', title }),
			}),
		};
		const attached = attachActions(actions, mockClient);

		const commands = buildActionCommands(attached);

		expect(commands).toHaveLength(1);
		expect(commands[0]?.command).toBe('create');
		expect(commands[0]?.describe).toBe('Mutation: create');
		expect(commands[0]?.builder).toHaveProperty('title');
	});

	test('builds commands from nested actions', () => {
		const actions: Actions = {
			posts: {
				getAll: defineQuery({
					handler: (_ctx) => [],
				}),
				create: defineMutation({
					input: type({ title: 'string' }),
					handler: (_ctx, { title }) => ({ id: '1', title }),
				}),
			},
		};
		const attached = attachActions(actions, mockClient);

		const commands = buildActionCommands(attached);

		expect(commands).toHaveLength(2);

		const commandNames = commands.map((c) => c.command);
		expect(commandNames).toContain('posts getAll');
		expect(commandNames).toContain('posts create');
	});

	test('builds commands from deeply nested actions', () => {
		const actions: Actions = {
			api: {
				v1: {
					posts: {
						list: defineQuery({
							handler: (_ctx) => [],
						}),
					},
				},
			},
		};
		const attached = attachActions(actions, mockClient);

		const commands = buildActionCommands(attached);

		expect(commands).toHaveLength(1);
		expect(commands[0]?.command).toBe('api v1 posts list');
	});

	test('uses description from action when provided', () => {
		const actions: Actions = {
			sync: defineMutation({
				description: 'Sync data from external source',
				handler: (_ctx) => {},
			}),
		};
		const attached = attachActions(actions, mockClient);

		const commands = buildActionCommands(attached);

		expect(commands[0]?.describe).toBe('Sync data from external source');
	});

	test('builder contains yargs options for input schema', () => {
		const actions: Actions = {
			create: defineMutation({
				input: type({
					title: 'string',
					'count?': 'number',
				}),
				handler: (_ctx, { title }) => ({ id: '1', title }),
			}),
		};
		const attached = attachActions(actions, mockClient);

		const commands = buildActionCommands(attached);
		const builder = commands[0]?.builder as Record<string, unknown>;

		expect(builder).toHaveProperty('title');
		expect(builder).toHaveProperty('count');
	});

	test('returns empty array for empty actions', () => {
		const commands = buildActionCommands({});
		expect(commands).toEqual([]);
	});

	test('handles mixed flat and nested actions', () => {
		const actions: Actions = {
			ping: defineQuery({
				handler: (_ctx) => 'pong',
			}),
			users: {
				list: defineQuery({
					handler: (_ctx) => [],
				}),
			},
		};
		const attached = attachActions(actions, mockClient);

		const commands = buildActionCommands(attached);

		expect(commands).toHaveLength(2);
		const commandNames = commands.map((c) => c.command);
		expect(commandNames).toContain('ping');
		expect(commandNames).toContain('users list');
	});
});
