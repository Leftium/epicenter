/**
 * Unit coverage for the pure section helpers in `list.ts`. Renderer text
 * output and CLI argv plumbing live in `test/e2e-list-peer.test.ts`; here
 * we lock the pure projections that build the Section[] the renderer
 * consumes.
 */

import { describe, expect, test } from 'bun:test';
import { defineMutation, defineQuery } from '@epicenter/workspace';
import Type from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { peerSection, selfSection } from '../daemon/handlers';
import { filterByPath } from './list';

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

const fakeEntry = (name: string, actions?: typeof fixtureActions) =>
	({
		name,
		workspace: {
			whenReady: Promise.resolve(),
			actions,
			[Symbol.dispose]() {},
		},
	}) as unknown as Parameters<typeof selfSection>[0];

describe('selfSection', () => {
	test('local mode uses the entry name as the label', () => {
		const section = selfSection(fakeEntry('demo', fixtureActions), 'local');
		expect(section.label).toBe('demo');
		expect(section.peer).toBe('self');
		expect(Object.keys(section.entries).sort()).toEqual([
			'counter.get',
			'counter.set',
		]);
	});

	test('all mode uses the canonical "self (this device)" label', () => {
		const section = selfSection(fakeEntry('demo', fixtureActions), 'all');
		expect(section.label).toBe('self (this device)');
	});

	test('handles workspace with no actions field', () => {
		const section = selfSection(fakeEntry('demo'), 'local');
		expect(section.entries).toEqual({});
	});

	test('local manifest preserves input schemas for detail-mode lookup', () => {
		const section = selfSection(fakeEntry('demo', fixtureActions), 'local');
		expect(section.entries['counter.set']?.input).toMatchObject({
			type: 'object',
		});
	});
});

describe('peerSection', () => {
	function fakeSync(opts: {
		findClientId?: number;
		describeResult?: Result<unknown, { name: string; message: string }>;
	}) {
		const clientId = opts.findClientId ?? 42;
		return {
			find: () =>
				opts.findClientId === undefined
					? undefined
					: { clientId, state: { device: { id: 'mac', name: 'mac', platform: 'web' } } },
			observe: () => () => {},
			rpc: async () => opts.describeResult ?? Ok({}),
		} as unknown as import('@epicenter/workspace').SyncAttachment;
	}

	test('fetches manifest via describePeer and renders "(online)" suffix when entries exist', async () => {
		const sync = fakeSync({
			findClientId: 42,
			describeResult: Ok({
				'tabs.close': {
					type: 'mutation',
					input: { type: 'object', properties: { tabIds: { type: 'array' } } },
				},
			}),
		});
		const section = await peerSection(
			{ device: { id: 'mac', name: 'mac', platform: 'tauri' } },
			sync,
		);
		expect(section.label).toBe('mac (online)');
		expect(section.peer).toBe('mac');
		expect(Object.keys(section.entries)).toEqual(['tabs.close']);
		expect(section.entries['tabs.close']?.input).toMatchObject({
			type: 'object',
		});
	});

	test('"(online, no actions)" suffix when manifest is empty', async () => {
		const sync = fakeSync({
			findClientId: 42,
			describeResult: Ok({}),
		});
		const section = await peerSection(
			{ device: { id: 'silent', name: 'silent', platform: 'web' } },
			sync,
		);
		expect(section.label).toContain('no actions');
		expect(section.entries).toEqual({});
	});

	test('surfaces RPC error as unavailableReason without crashing', async () => {
		const sync = fakeSync({
			findClientId: 42,
			describeResult: Err({ name: 'ActionFailed', message: 'boom' }),
		});
		const section = await peerSection(
			{ device: { id: 'mac', name: 'mac', platform: 'tauri' } },
			sync,
		);
		expect(section.label).toContain('schema unavailable');
		expect(section.unavailableReason).toBe('boom');
		expect(section.entries).toEqual({});
	});

});

describe('filterByPath', () => {
	const entries = {
		'counter.get': { type: 'query' as const },
		'counter.set': { type: 'mutation' as const },
		'other.thing': { type: 'query' as const },
	};

	test('empty path returns the input unchanged', () => {
		expect(filterByPath(entries, '')).toBe(entries);
	});

	test('exact-leaf path returns just that leaf', () => {
		expect(Object.keys(filterByPath(entries, 'counter.get'))).toEqual([
			'counter.get',
		]);
	});

	test('subtree prefix returns descendants', () => {
		expect(Object.keys(filterByPath(entries, 'counter')).sort()).toEqual([
			'counter.get',
			'counter.set',
		]);
	});

	test('non-matching prefix returns empty', () => {
		expect(filterByPath(entries, 'nope')).toEqual({});
	});
});
