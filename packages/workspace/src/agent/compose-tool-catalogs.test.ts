import { describe, expect, test } from 'bun:test';
import { composeToolCatalogs } from './compose-tool-catalogs.js';
import type {
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from './tools.js';

/** A stub catalog: fixed definitions, and a resolve that echoes which catalog ran. */
function stubCatalog(
	label: string,
	names: string[],
	{ kind = 'query' as const }: { kind?: 'query' | 'mutation' } = {},
): ToolCatalog {
	return {
		definitions: (): AgentToolDefinition[] =>
			names.map((name) => ({ name, kind })),
		resolve: async (call): Promise<AgentToolOutcome> => ({
			output: `${label}:${call.toolName}`,
			isError: false,
		}),
	};
}

const call = (toolName: string) => ({ toolCallId: '1', toolName, input: null });
const signal = new AbortController().signal;

describe('composeToolCatalogs', () => {
	test('unions definitions across catalogs', () => {
		const merged = composeToolCatalogs([
			stubCatalog('a', ['one', 'two']),
			stubCatalog('b', ['three']),
		]);
		expect(merged.definitions().map((d) => d.name).sort()).toEqual([
			'one',
			'three',
			'two',
		]);
	});

	test('first catalog wins a name collision in definitions', () => {
		const merged = composeToolCatalogs([
			stubCatalog('local', ['shared'], { kind: 'mutation' }),
			stubCatalog('remote', ['shared'], { kind: 'query' }),
		]);
		const definitions = merged.definitions();
		expect(definitions).toHaveLength(1);
		// The earliest catalog owns the offered definition (its `kind`, here).
		expect(definitions[0]).toMatchObject({ name: 'shared', kind: 'mutation' });
	});

	test('resolve routes to the catalog that owns the tool', async () => {
		const merged = composeToolCatalogs([
			stubCatalog('a', ['one']),
			stubCatalog('b', ['two']),
		]);
		expect(await merged.resolve(call('two'), signal)).toEqual({
			output: 'b:two',
			isError: false,
		});
	});

	test('resolve of a collided name runs the earliest catalog', async () => {
		const merged = composeToolCatalogs([
			stubCatalog('local', ['shared']),
			stubCatalog('remote', ['shared']),
		]);
		expect(await merged.resolve(call('shared'), signal)).toEqual({
			output: 'local:shared',
			isError: false,
		});
	});

	test('resolve of an unknown tool is an error outcome, not a throw', async () => {
		const merged = composeToolCatalogs([stubCatalog('a', ['one'])]);
		const outcome = await merged.resolve(call('missing'), signal);
		expect(outcome.isError).toBe(true);
		expect(outcome.output).toContain('missing');
	});

	test('a getter source is read live so a later-mounted catalog appears', async () => {
		const catalogs: ToolCatalog[] = [stubCatalog('local', ['one'])];
		const merged = composeToolCatalogs(() => catalogs);
		expect(merged.definitions().map((d) => d.name)).toEqual(['one']);

		catalogs.push(stubCatalog('device', ['remote']));
		expect(merged.definitions().map((d) => d.name).sort()).toEqual([
			'one',
			'remote',
		]);
		expect(await merged.resolve(call('remote'), signal)).toEqual({
			output: 'device:remote',
			isError: false,
		});
	});
});
