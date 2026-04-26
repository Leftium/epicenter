import { describe, expect, it } from 'bun:test';
import Type from 'typebox';
import { defineMutation, defineQuery } from './actions.js';
import { actionManifest } from './action-manifest.js';

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
});
