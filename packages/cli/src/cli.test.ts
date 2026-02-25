/**
 * CLI Command Registration Tests
 *
 * These tests verify that action contracts are transformed into yargs command
 * registrations with callable handlers and parsed option values. They protect command
 * discoverability and argument parsing behavior used by the CLI entrypoint.
 *
 * Key behaviors:
 * - Registers flat and nested action paths as yargs commands
 * - Parses command input into typed action handler arguments
 */
import { describe, expect, test } from 'bun:test';
import { defineMutation, defineQuery } from '@epicenter/hq';
import Type from 'typebox';
import yargs from 'yargs';
import { buildActionCommands } from './command-builder';

/**
 * Yargs exposes `getInternalMethods()` at runtime but not in its public type
 * definitions. This helper casts the Argv instance so we can inspect registered
 * commands in tests without scattering casts throughout the file.
 */
function getYargsCommands(cli: ReturnType<typeof yargs>): {
	getCommands(): string[];
	getCommandHandlers(): Record<
		string,
		{ handler: (...args: unknown[]) => unknown }
	>;
} {
	// Accessing yargs private API for test inspection — no public equivalent exists
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

	test('command handlers are functions on the registered command', () => {
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

	test('parseAsync extracts typed options from flat command', async () => {
		let capturedArgs: Record<string, unknown> | null = null;

		const actions = {
			create: defineMutation({
				input: Type.Object({ title: Type.String(), count: Type.Optional(Type.Number()) }),
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
					input: Type.Object({ title: Type.String() }),
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
