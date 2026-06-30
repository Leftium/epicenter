import { describe, expect, test } from 'bun:test';
import {
	defineActions,
	defineMutation,
	defineQuery,
} from '../shared/actions.js';
import { createLocalToolCatalog } from './local-tool-catalog.js';

const NO_SIGNAL = new AbortController().signal;

describe('createLocalToolCatalog', () => {
	test('lists every local action as a tool definition', () => {
		const catalog = createLocalToolCatalog(
			defineActions({
				local_now: defineQuery({
					description: 'local clock',
					handler: () => ({ now: 1 }),
				}),
				mark_reviewed: defineMutation({
					title: 'Mark reviewed',
					handler: () => null,
				}),
			}),
		);

		const byName = new Map(catalog.definitions().map((d) => [d.name, d]));
		expect([...byName.keys()].sort()).toEqual(['local_now', 'mark_reviewed']);
		expect(byName.get('local_now')?.kind).toBe('query');
		expect(byName.get('local_now')?.description).toBe('local clock');
		// A mutation is marked so the loop can gate it (ADR-0044).
		expect(byName.get('mark_reviewed')?.kind).toBe('mutation');
	});

	test('resolves a local action in-process', async () => {
		const catalog = createLocalToolCatalog(
			defineActions({
				local_now: defineQuery({ handler: () => ({ now: 7 }) }),
			}),
		);

		const outcome = await catalog.resolve(
			{ toolCallId: 'c1', toolName: 'local_now', input: {} },
			NO_SIGNAL,
		);

		expect(outcome).toEqual({ output: { now: 7 }, isError: false });
	});

	test('a handler that fails becomes an error outcome the model can read', async () => {
		const catalog = createLocalToolCatalog(
			defineActions({
				boom: defineMutation({
					handler: () => {
						throw new Error('kaboom');
					},
				}),
			}),
		);

		const outcome = await catalog.resolve(
			{ toolCallId: 'c2', toolName: 'boom', input: {} },
			NO_SIGNAL,
		);

		expect(outcome.isError).toBe(true);
		expect(typeof outcome.output).toBe('string');
	});

	test('an unknown tool resolves to an error rather than throwing', async () => {
		const catalog = createLocalToolCatalog({});
		const outcome = await catalog.resolve(
			{ toolCallId: 'c3', toolName: 'nope', input: {} },
			NO_SIGNAL,
		);

		expect(outcome.isError).toBe(true);
	});
});
