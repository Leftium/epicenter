/**
 * Tool bridge tests — verifies the mapping between workspace actions and
 * TanStack AI tool representations.
 */

import { describe, expect, test } from 'bun:test';
import { defineMutation, defineQuery } from '@epicenter/workspace';
import { actionsToClientTools, toToolDefinitions } from './tool-bridge.js';

describe('actionsToClientTools', () => {
	test('destructive action sets needsApproval without blanket option', () => {
		const actions = {
			tabs: {
				close: defineMutation({
					title: 'Close Tabs',
					description: 'Close tabs',
					destructive: true,
					handler: () => {},
				}),
				open: defineMutation({
					title: 'Open Tab',
					description: 'Open a tab',
					handler: () => {},
				}),
			},
		};

		const tools = actionsToClientTools(actions);

		const closeTool = tools.find((t) => t.name === 'tabs_close');
		expect(closeTool).toBeDefined();
		expect(closeTool?.needsApproval).toBe(true);

		const openTool = tools.find((t) => t.name === 'tabs_open');
		expect(openTool).toBeDefined();
		expect(openTool?.needsApproval).toBeUndefined();
	});

	test('non-destructive tools omit needsApproval entirely', () => {
		const actions = {
			query: defineQuery({
				title: 'Query',
				description: 'Query data',
				handler: () => {},
			}),
			mutation: defineMutation({
				title: 'Mutation',
				description: 'Mutate data',
				handler: () => {},
			}),
		};

		const tools = actionsToClientTools(actions);

		const queryTool = tools.find((t) => t.name === 'query');
		expect(queryTool).toBeDefined();
		expect('needsApproval' in queryTool!).toBe(false);

		const mutationTool = tools.find((t) => t.name === 'mutation');
		expect(mutationTool).toBeDefined();
		expect('needsApproval' in mutationTool!).toBe(false);
	});
});

describe('toToolDefinitions', () => {
	test('produces wire-safe definitions', () => {
		const actions = {
			search: defineQuery({
				title: 'Search',
				description: 'Search stuff',
				handler: () => {},
			}),
		};

		const tools = actionsToClientTools(actions);
		const definitions = toToolDefinitions(tools);

		expect(definitions).toHaveLength(1);
		expect(definitions[0]?.name).toBe('search');
		expect(definitions[0]?.description).toBe('Search stuff');
	});

	test('only forwards needsApproval for destructive tools', () => {
		const actions = {
			destructive: defineMutation({
				title: 'Destructive',
				description: 'Destructive action',
				destructive: true,
				handler: () => {},
			}),
			safe: defineQuery({
				title: 'Safe',
				description: 'Safe action',
				handler: () => {},
			}),
		};

		const tools = actionsToClientTools(actions);
		const definitions = toToolDefinitions(tools);

		const destructiveDef = definitions.find((d) => d.name === 'destructive');
		expect(destructiveDef?.needsApproval).toBe(true);

		const safeDef = definitions.find((d) => d.name === 'safe');
		expect('needsApproval' in safeDef!).toBe(false);
	});
});
