/**
 * Minimal fixture: one daemon route with inline `defineQuery` /
 * `defineMutation` nodes grouped under `actions:`. No sqlite or encryption,
 * no real WebSocket: a hand-stubbed `workspace` matches the daemon's
 * structural contract so `loadDaemonConfig` accepts it.
 *
 * CLI paths are `demo.counter.{get,increment,set}`.
 */

import { defineMutation, defineQuery } from '@epicenter/workspace';
import { defineConfig } from '@epicenter/workspace/daemon';
import Type from 'typebox';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

const ydoc = new Y.Doc({ guid: 'epicenter.demo' });
const state = ydoc.getMap<number>('state');
state.set('count', 0);

const awareness = new Awareness(ydoc);

const actions = {
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
};

const workspace = {
	identity: { id: 'fixture', name: 'fixture', platform: 'node' as const },
	actions,
	awareness,
	status: { phase: 'connected' as const },
	whenConnected: Promise.resolve(),
	whenDisposed: Promise.resolve(),
	onStatusChange: () => () => {},
	reconnect: () => {},
	goOffline: () => {},
	peers: {
		list: () => [],
		find: () => undefined,
		observe: () => () => {},
	},
	[Symbol.dispose]() {
		ydoc.destroy();
	},
};

export const demo = {
	workspaceId: ydoc.guid,
	workspace,
	async [Symbol.asyncDispose]() {
		ydoc.destroy();
	},
	ydoc,
};

export default defineConfig({
	daemon: {
		routes: [{ route: 'demo', start: () => demo }],
	},
});
