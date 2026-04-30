import { createSessionStore } from '@epicenter/cli';
import {
	attachSync,
	attachTables,
	defineMutation,
	defineQuery,
	defineTable,
	type PeerDescriptor,
	toWsUrl,
} from '@epicenter/workspace';
import { type } from 'arktype';
import Type from 'typebox';
import * as Y from 'yjs';

const SERVER_URL = 'https://api.epicenter.so';
const WORKSPACE_ID = 'epicenter.notes-repro';

// `_v: '1'` here is arktype syntax for the literal NUMBER 1 (numeric strings
// in arktype's type position resolve to number literals). The `set()` call
// below passes `_v: 1` — same value, two different syntax conventions.
const Note = defineTable(type({ id: 'string', body: 'string', _v: '1' }));

export function openNotes(peer: PeerDescriptor) {
	const ydoc = new Y.Doc({ guid: WORKSPACE_ID });
	const tables = attachTables(ydoc, { notes: Note });

	const actions = {
		notes: {
			list: defineQuery({
				description: 'List all notes',
				handler: () => tables.notes.getAllValid(),
			}),
			add: defineMutation({
				description: 'Add a note',
				input: Type.Object({ body: Type.String() }),
				handler: ({ body }) =>
					tables.notes.set({ id: crypto.randomUUID(), body, _v: 1 }),
			}),
		},
	};

	const sessions = createSessionStore();
	const sync = attachSync(ydoc, {
		url: toWsUrl(`${SERVER_URL}/workspaces/${WORKSPACE_ID}`),
		getToken: async () =>
			(await sessions.load(SERVER_URL))?.accessToken ?? null,
	});
	const presence = sync.attachPresence({ peer });
	const rpc = sync.attachRpc({ actions: { actions } });

	return {
		actions,
		presence,
		rpc,
		sync,
		whenReady: sync.whenConnected,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
