import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import yargs from 'yargs';
import {
	type Actions,
	attachActions,
	defineMutation,
	defineQuery,
} from '../shared/actions';
import { buildActionCommands } from './command-builder';

// Mock client for attaching actions
const mockClient = { id: 'test' };

describe('CLI command registration', () => {
	test('registers flat action commands with yargs', () => {
		const actions: Actions = {
			ping: defineQuery({
				handler: (_ctx) => 'pong',
			}),
			sync: defineMutation({
				handler: (_ctx) => {},
			}),
		};
		const attached = attachActions(actions, mockClient);

		const commands = buildActionCommands(attached);

		let cli = yargs().scriptName('test');
		for (const cmd of commands) {
			cli = cli.command(cmd);
		}

		const commandInstance = cli.getInternalMethods().getCommandInstance();
		const registeredCommands = commandInstance.getCommands();

		expect(registeredCommands).toContain('ping');
		expect(registeredCommands).toContain('sync');
	});

	test('registers nested commands with top-level parent', () => {
		const actions: Actions = {
			posts: {
				list: defineQuery({
					handler: (_ctx) => [],
				}),
			},
		};
		const attached = attachActions(actions, mockClient);

		const commands = buildActionCommands(attached);

		let cli = yargs().scriptName('test');
		for (const cmd of commands) {
			cli = cli.command(cmd);
		}

		const commandInstance = cli.getInternalMethods().getCommandInstance();
		const registeredCommands = commandInstance.getCommands();

		expect(registeredCommands).toContain('posts');
	});

	test('command handlers are accessible', () => {
		const actions: Actions = {
			ping: defineQuery({
				handler: (_ctx) => 'pong',
			}),
		};
		const attached = attachActions(actions, mockClient);

		const commands = buildActionCommands(attached);

		let cli = yargs().scriptName('test');
		for (const cmd of commands) {
			cli = cli.command(cmd);
		}

		const commandInstance = cli.getInternalMethods().getCommandInstance();
		const handlers = commandInstance.getCommandHandlers();

		expect(handlers).toHaveProperty('ping');
		expect(typeof handlers.ping?.handler).toBe('function');
	});

	test('parses flat command options correctly', async () => {
		let capturedArgs: Record<string, unknown> | null = null;

		const actions: Actions = {
			create: defineMutation({
				input: type({ title: 'string', 'count?': 'number' }),
				handler: (_ctx, { title, count }) => {
					capturedArgs = { title, count };
					return { id: '1', title };
				},
			}),
		};
		const attached = attachActions(actions, mockClient);

		const commands = buildActionCommands(attached);

		let cli = yargs()
			.scriptName('test')
			.fail(() => {});
		for (const cmd of commands) {
			cli = cli.command(cmd);
		}

		await cli.parseAsync(['create', '--title', 'Hello', '--count', '42']);

		expect(capturedArgs).not.toBeNull();
		expect(capturedArgs?.title).toBe('Hello');
		expect(capturedArgs?.count).toBe(42);
	});

	test('buildActionCommands returns correct command paths', () => {
		const actions: Actions = {
			ping: defineQuery({ handler: (_ctx) => 'pong' }),
			posts: {
				list: defineQuery({ handler: (_ctx) => [] }),
				create: defineMutation({
					input: type({ title: 'string' }),
					handler: (_ctx, { title }) => ({ title }),
				}),
			},
		};
		const attached = attachActions(actions, mockClient);

		const commands = buildActionCommands(attached);
		const commandPaths = commands.map((c) => c.command);

		expect(commandPaths).toContain('ping');
		expect(commandPaths).toContain('posts list');
		expect(commandPaths).toContain('posts create');
	});
});
