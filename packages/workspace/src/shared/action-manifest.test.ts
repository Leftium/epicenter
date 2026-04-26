import { describe, expect, it, test } from 'bun:test';
import Type from 'typebox';
import type { ActionMeta } from './actions.js';
import { defineMutation, defineQuery } from './actions.js';
import type { ActionManifestEntry } from './action-manifest.js';
import { actionManifest } from './action-manifest.js';

// Type-level invariant: ActionManifestEntry IS ActionMeta. The renderer in
// the CLI relies on this — local actions and remote manifest entries flow
// through the same code path. If this dedup ever drifts, the assignments
// below stop compiling.
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
		? true
		: false;
const _entryEqualsMeta: Equal<ActionManifestEntry, ActionMeta> = true;
void _entryEqualsMeta;

test('ActionManifestEntry is structurally identical to ActionMeta', () => {
	// Runtime equivalent of the type-level check: a plain object that
	// satisfies ActionMeta also satisfies ActionManifestEntry, both ways.
	const meta: ActionMeta = { type: 'query' };
	const entry: ActionManifestEntry = meta;
	const back: ActionMeta = entry;
	expect(back).toEqual(meta);
});

describe('actionManifest', () => {
	it('flattens nested action trees to dot-path keys', () => {
		const actions = {
			entries: {
				create: defineMutation({
					title: 'Create Entry',
					input: Type.Object({ title: Type.String() }),
					handler: () => ({ id: 'x' }),
				}),
				delete: defineMutation({
					handler: ({ id }: { id: string }) => ({ deleted: id }),
					input: Type.Object({ id: Type.String() }),
				}),
			},
			tabs: {
				close: defineMutation({
					input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
					handler: () => ({ closedCount: 0 }),
				}),
			},
		};

		const manifest = actionManifest(actions);

		expect(Object.keys(manifest).sort()).toEqual([
			'entries.create',
			'entries.delete',
			'tabs.close',
		]);
	});

	it('includes JSON Schema for actions with input', () => {
		const actions = {
			create: defineMutation({
				input: Type.Object({ name: Type.String() }),
				handler: () => undefined,
			}),
		};

		const manifest = actionManifest(actions);
		const entry = manifest.create;
		if (!entry) throw new Error('expected create entry');
		expect(entry.input).toBeDefined();
		expect((entry.input as { type: string }).type).toBe('object');
		expect((entry.input as { properties: object }).properties).toMatchObject({
			name: { type: 'string' },
		});
	});

	it('omits input field for no-input actions', () => {
		const actions = {
			ping: defineQuery({ handler: () => 'pong' }),
		};
		const manifest = actionManifest(actions);
		const entry = manifest.ping;
		if (!entry) throw new Error('expected ping entry');
		expect(entry.input).toBeUndefined();
		expect(entry.type).toBe('query');
	});

	it('preserves type, title, description metadata', () => {
		const actions = {
			act: defineMutation({
				title: 'The Act',
				description: 'Does the thing',
				handler: () => undefined,
			}),
		};
		const manifest = actionManifest(actions);
		expect(manifest.act).toEqual({
			type: 'mutation',
			title: 'The Act',
			description: 'Does the thing',
		});
	});

	it('skips non-action, non-namespace values', () => {
		const actions = {
			real: defineMutation({ handler: () => undefined }),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			notAnAction: 'a string' as any,
		};
		const manifest = actionManifest(actions);
		expect(Object.keys(manifest)).toEqual(['real']);
	});

	it('survives JSON round-trip — wire-safe, no symbol-keyed properties', () => {
		const actions = {
			entries: {
				create: defineMutation({
					title: 'Create Entry',
					description: 'Make one',
					input: Type.Object({ title: Type.String() }),
					handler: () => ({ id: 'x' }),
				}),
				delete: defineMutation({
					handler: ({ id }: { id: string }) => ({ deleted: id }),
					input: Type.Object({ id: Type.String() }),
				}),
			},
		};

		const manifest = actionManifest(actions);
		const roundTripped = JSON.parse(JSON.stringify(manifest));

		expect(roundTripped).toEqual({
			'entries.create': {
				type: 'mutation',
				title: 'Create Entry',
				description: 'Make one',
				input: {
					type: 'object',
					properties: { title: { type: 'string' } },
					required: ['title'],
				},
			},
			'entries.delete': {
				type: 'mutation',
				input: {
					type: 'object',
					properties: { id: { type: 'string' } },
					required: ['id'],
				},
			},
		});
	});
});
