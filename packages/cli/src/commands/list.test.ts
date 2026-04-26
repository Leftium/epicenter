/**
 * Unit coverage for the source-agnostic helpers in `list.ts`. The renderer
 * itself is exercised end-to-end against the inline-actions fixture in
 * `test/e2e-inline-actions.test.ts`; here we lock the pure projection
 * helpers so the source contract (Map<dotPath, ActionMeta>) is enforced
 * regardless of where the entries came from.
 */

import { describe, expect, test } from 'bun:test';
import { defineMutation, defineQuery } from '@epicenter/workspace';
import Type from 'typebox';
import { sourceAll, sourceLocal, sourcePeer } from './list';

const fixtureActions = {
	counter: {
		get: defineQuery({
			description: 'Read the current counter value',
			handler: () => 0,
		}),
		set: defineMutation({
			description: 'Overwrite the counter value',
			input: Type.Object({ value: Type.Number() }),
			handler: ({ value }: { value: number }) => value,
		}),
	},
};

describe('sourceLocal', () => {
	test('returns flat dot-path map over a nested action tree', () => {
		const map = sourceLocal(fixtureActions);
		expect([...map.keys()].sort()).toEqual(['counter.get', 'counter.set']);
	});

	test('preserves type/description/input metadata on each entry', () => {
		const map = sourceLocal(fixtureActions);
		expect(map.get('counter.get')).toMatchObject({
			type: 'query',
			description: 'Read the current counter value',
		});
		const setEntry = map.get('counter.set');
		expect(setEntry?.type).toBe('mutation');
		expect(setEntry?.input).toBeDefined();
	});

	test('returns empty map for undefined or empty actions', () => {
		expect(sourceLocal(undefined).size).toBe(0);
		expect(sourceLocal({}).size).toBe(0);
	});
});

describe('sourcePeer', () => {
	test('reads device.offers as a flat dot-path map', () => {
		const state = {
			device: {
				id: 'mac-1',
				name: 'mac',
				offers: {
					'tabs.close': { type: 'mutation' as const },
					'tabs.list': { type: 'query' as const, description: 'List' },
				},
			},
		};
		const map = sourcePeer(state);
		expect([...map.keys()].sort()).toEqual(['tabs.close', 'tabs.list']);
		expect(map.get('tabs.list')).toMatchObject({
			type: 'query',
			description: 'List',
		});
	});

	test('returns empty map when device.offers is undefined', () => {
		const map = sourcePeer({ device: { id: 'x', name: 'y' } });
		expect(map.size).toBe(0);
	});

	test('returns empty map when state has no device field', () => {
		expect(sourcePeer({}).size).toBe(0);
	});
});

describe('sourceAll', () => {
	function fakeWorkspace(opts: {
		actions?: typeof fixtureActions;
		peers?: Map<number, unknown>;
	}) {
		const peers = opts.peers ?? new Map();
		const selfId = 1;
		return {
			whenReady: Promise.resolve(),
			actions: opts.actions,
			awareness: {
				clientID: selfId,
				getStates: () => new Map([[selfId, {}], ...peers]),
			},
			[Symbol.dispose]() {},
		} as unknown as Parameters<typeof sourceAll>[0];
	}

	test('self section is always first, even with no peers', () => {
		const sections = sourceAll(fakeWorkspace({ actions: fixtureActions }));
		expect(sections).toHaveLength(1);
		expect(sections[0]!.peer).toBe('self');
		expect([...sections[0]!.entries.keys()].sort()).toEqual([
			'counter.get',
			'counter.set',
		]);
	});

	test('peers ordered by clientID asc; self stays first', () => {
		const peers = new Map<number, unknown>([
			[
				900,
				{
					device: {
						id: 'late',
						name: 'late',
						platform: 'web',
						offers: {},
					},
				},
			],
			[
				100,
				{
					device: {
						id: 'early',
						name: 'early',
						platform: 'web',
						offers: { 'tabs.close': { type: 'mutation' as const } },
					},
				},
			],
		]);
		const sections = sourceAll(
			fakeWorkspace({ actions: fixtureActions, peers }),
		);
		expect(sections.map((s) => s.peer)).toEqual(['self', 'early', 'late']);
	});

	test('peer with no offers renders with empty entries (not omitted)', () => {
		const peers = new Map<number, unknown>([
			[2, { device: { id: 'silent', name: 'silent', platform: 'web' } }],
		]);
		const sections = sourceAll(
			fakeWorkspace({ actions: fixtureActions, peers }),
		);
		expect(sections).toHaveLength(2);
		expect(sections[1]!.entries.size).toBe(0);
		expect(sections[1]!.label).toContain('offers: 0');
	});
});
