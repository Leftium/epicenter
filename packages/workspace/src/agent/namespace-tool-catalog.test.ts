import { describe, expect, test } from 'bun:test';
import { composeToolCatalogs } from './compose-tool-catalogs.js';
import { namespaceToolCatalog } from './namespace-tool-catalog.js';
import type {
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from './tools.js';

function stubCatalog(label: string, names: string[]): ToolCatalog {
	return {
		definitions: (): AgentToolDefinition[] =>
			names.map((name) => ({ name, kind: 'query' })),
		resolve: async (call): Promise<AgentToolOutcome> => ({
			output: `${label}:${call.toolName}`,
			isError: false,
		}),
	};
}

const call = (toolName: string) => ({ toolCallId: '1', toolName, input: null });
const signal = new AbortController().signal;

describe('namespaceToolCatalog', () => {
	test('prefixes every definition name', () => {
		const catalog = namespaceToolCatalog('dev_books', stubCatalog('a', ['customers']));
		expect(catalog.definitions().map((d) => d.name)).toEqual([
			'dev_books__customers',
		]);
	});

	test('resolve strips the prefix and delegates the bare name', async () => {
		const catalog = namespaceToolCatalog('dev_books', stubCatalog('a', ['customers']));
		expect(await catalog.resolve(call('dev_books__customers'), signal)).toEqual({
			output: 'a:customers',
			isError: false,
		});
	});

	test('an unprefixed name is not owned by this catalog', async () => {
		const catalog = namespaceToolCatalog('dev_books', stubCatalog('a', ['customers']));
		const outcome = await catalog.resolve(call('customers'), signal);
		expect(outcome.isError).toBe(true);
	});

	test('a bare name containing the separator round-trips (slice by length)', async () => {
		const catalog = namespaceToolCatalog('p', stubCatalog('a', ['weird__name']));
		expect(catalog.definitions()[0]?.name).toBe('p__weird__name');
		expect(await catalog.resolve(call('p__weird__name'), signal)).toEqual({
			output: 'a:weird__name',
			isError: false,
		});
	});

	test('two devices serving the same tool name coexist under composition', async () => {
		const merged = composeToolCatalogs([
			namespaceToolCatalog('alpha_books', stubCatalog('alpha', ['customers'])),
			namespaceToolCatalog('beta_books', stubCatalog('beta', ['customers'])),
		]);
		expect(merged.definitions().map((d) => d.name).sort()).toEqual([
			'alpha_books__customers',
			'beta_books__customers',
		]);
		expect(await merged.resolve(call('beta_books__customers'), signal)).toEqual({
			output: 'beta:customers',
			isError: false,
		});
	});
});
