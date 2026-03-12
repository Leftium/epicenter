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

	test('destructive + requireApprovalForMutations both set needsApproval', () => {
		const actions = {
			read: defineQuery({
				title: 'Read',
				description: 'Read data',
				destructive: true,
				handler: () => {},
			}),
			write: defineMutation({
				title: 'Write',
				description: 'Write data',
				handler: () => {},
			}),
		};

		const tools = actionsToClientTools(actions, {
			requireApprovalForMutations: true,
		});

		// Destructive query gets needsApproval
		const readTool = tools.find((t) => t.name === 'read');
		expect(readTool?.needsApproval).toBe(true);

		// Mutation gets needsApproval from blanket option
		const writeTool = tools.find((t) => t.name === 'write');
		expect(writeTool?.needsApproval).toBe(true);
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
});
