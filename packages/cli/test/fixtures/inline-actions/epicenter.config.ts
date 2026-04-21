/**
 * Minimal fixture — one document handle with inline `defineQuery` / `defineMutation`
 * nodes. No sqlite, sync, or encryption: the `DocumentBundle` contract is
 * just `{ ydoc, [Symbol.dispose] }` and that is all this fixture needs.
 *
 * Used by `test/e2e-inline-actions.test.ts` to exercise dot-path resolution
 * end-to-end without depending on any attach primitive.
 */

import {
	defineDocument,
	defineMutation,
	defineQuery,
} from '@epicenter/workspace';
import Type from 'typebox';
import * as Y from 'yjs';

const demoFactory = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const state = ydoc.getMap<number>('state');
	state.set('count', 0);

	return {
		ydoc,
		counter: {
			get: defineQuery({
				description: 'Read the current counter value',
				handler: () => state.get('count') ?? 0,
			}),
			increment: defineMutation({
				description: 'Increment the counter by one',
				handler: () => {
					const next = (state.get('count') ?? 0) + 1;
					state.set('count', next);
					return next;
				},
			}),
			set: defineMutation({
				description: 'Overwrite the counter value',
				input: Type.Object({ value: Type.Number() }),
				handler: ({ value }: { value: number }) => {
					state.set('count', value);
					return value;
				},
			}),
		},
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

export const demo = demoFactory.open('epicenter.demo');
