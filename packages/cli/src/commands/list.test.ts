/**
 * Unit coverage for the pure section helpers in `list.ts`. Renderer text
 * output and CLI argv plumbing live in `test/e2e-list-peer.test.ts`; here
 * we lock the pure projections that build the Section[] the renderer
 * consumes.
 */

import { describe, expect, test } from 'bun:test';
import { defineMutation, defineQuery } from '@epicenter/workspace';
import Type from 'typebox';
import { filterByPath, peerSection, selfSection } from './list';

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
});

describe('peerSection', () => {
	test('reads device.offers and device.name; uses "(online)" suffix when offers exist', () => {
		const section = peerSection({
			device: {
				id: 'mac-1',
				name: 'mac',
				platform: 'tauri',
				offers: { 'tabs.close': { type: 'mutation' } },
			},
		});
		expect(section.label).toBe('mac (online)');
		expect(section.peer).toBe('mac-1');
		expect(Object.keys(section.entries)).toEqual(['tabs.close']);
	});

	test('falls back to deviceId when name is missing', () => {
		const section = peerSection({
			device: { id: '0xabc', name: '', platform: 'web', offers: {} },
		});
		expect(section.label).toBe('0xabc (online, offers: 0)');
	});

	test('uses clientID label when device is missing', () => {
		const section = peerSection({}, 999);
		expect(section.label).toBe('clientID 999 (online, offers: 0)');
		expect(section.peer).toBe('clientID:999');
	});

	test('"(online, offers: 0)" suffix when manifest is empty', () => {
		const section = peerSection({
			device: { id: 'silent', name: 'silent', platform: 'web', offers: {} },
		});
		expect(section.label).toContain('offers: 0');
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
