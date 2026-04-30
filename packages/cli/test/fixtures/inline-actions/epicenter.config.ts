/**
 * Minimal fixture: one daemon host with inline `defineQuery` /
 * `defineMutation` nodes grouped under `actions:`. No sqlite, sync, or
 * encryption. The CLI walks `workspace.actions`, so CLI paths are
 * `demo.counter.{get,increment,set}`.
 */

import { defineMutation, defineQuery } from '@epicenter/workspace';
import {
	defineDaemon,
	defineEpicenterConfig,
} from '@epicenter/workspace/daemon';
import Type from 'typebox';
import * as Y from 'yjs';

const ydoc = new Y.Doc({ guid: 'epicenter.demo' });
const state = ydoc.getMap<number>('state');
state.set('count', 0);

export const demo = {
	actions: {
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
	},
	[Symbol.dispose]() {
		ydoc.destroy();
	},
	// Extras for direct script use, not part of the hosted workspace contract.
	ydoc,
};

export default defineEpicenterConfig({
	hosts: [
		defineDaemon({
			route: 'demo',
			title: 'Demo',
			workspaceId: 'epicenter.demo',
			start: () => demo,
		}),
	],
});
