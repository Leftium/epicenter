import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import yargs from 'yargs';
import { defineMutation, defineQuery } from '../shared/actions';
import { buildActionCommands } from './command-builder';

/**
 * Yargs exposes `getInternalMethods()` at runtime but not in its public type
 * definitions. This helper casts the Argv instance so we can inspect registered
 * commands in tests without scattering casts throughout the file.
 */
function getYargsCommands(cli: ReturnType<typeof yargs>): {
	getCommands(): string[];
	getCommandHandlers(): Record<string, { handler: Function }>;
} {
	return (
		cli as unknown as {
			getInternalMethods(): {
				getCommandInstance(): ReturnType<typeof getYargsCommands>;
			};
		}
	)
		.getInternalMethods()
		.getCommandInstance();
}

describe('CLI command registration', () => {
	test('registers flat action commands with yargs', () => {
		const actions = {
			ping: defineQuery({
				handler: () => 'pong',
			}),
			sync: defineMutation({
				handler: () => {},
			}),
		};

		const commands = buildActionCommands(actions);

		let cli = yargs().scriptName('test');
		for (const cmd of commands) {
			cli = cli.command(cmd);
		}

		const commandInstance = getYargsCommands(cli);
		const registeredCommands = commandInstance.getCommands();

		expect(registeredCommands).toContain('ping');
		expect(registeredCommands).toContain('sync');
	});

	test('registers nested commands with top-level parent', () => {
		const actions = {
			posts: {
				list: defineQuery({
					handler: () => [],
				}),
			},
		};

		const commands = buildActionCommands(actions);

		let cli = yargs().scriptName('test');
		for (const cmd of commands) {
			cli = cli.command(cmd);
		}

		const commandInstance = getYargsCommands(cli);
		const registeredCommands = commandInstance.getCommands();

		expect(registeredCommands).toContain('posts');
	});

	test('command handlers are accessible', () => {
		const actions = {
			ping: defineQuery({
				handler: () => 'pong',
			}),
		};

		const commands = buildActionCommands(actions);

		let cli = yargs().scriptName('test');
		for (const cmd of commands) {
			cli = cli.command(cmd);
		}

		const commandInstance = getYargsCommands(cli);
		const handlers = commandInstance.getCommandHandlers();

		expect(handlers).toHaveProperty('ping');
		expect(typeof handlers.ping?.handler).toBe('function');
	});

	test('parses flat command options correctly', async () => {
		let capturedArgs: Record<string, unknown> | null = null;

		const actions = {
			create: defineMutation({
				input: type({ title: 'string', 'count?': 'number' }),
				handler: ({ title, count }) => {
					capturedArgs = { title, count };
					return { id: '1', title };
				},
			}),
		};

		const commands = buildActionCommands(actions);

		let cli = yargs()
			.scriptName('test')
			.fail(() => {});
		for (const cmd of commands) {
			cli = cli.command(cmd);
		}

		await cli.parseAsync(['create', '--title', 'Hello', '--count', '42']);

		if (capturedArgs === null) throw new Error('capturedArgs is null');
		expect(capturedArgs).toMatchObject({ title: 'Hello', count: 42 });
	});

	test('buildActionCommands returns correct command paths', () => {
		const actions = {
			ping: defineQuery({ handler: () => 'pong' }),
			posts: {
				list: defineQuery({ handler: () => [] }),
				create: defineMutation({
					input: type({ title: 'string' }),
					handler: ({ title }) => ({ title }),
				}),
			},
		};

		const commands = buildActionCommands(actions);
		const commandPaths = commands.map((c) => c.command);

		expect(commandPaths).toContain('ping');
		expect(commandPaths).toContain('posts list');
		expect(commandPaths).toContain('posts create');
	});
});
