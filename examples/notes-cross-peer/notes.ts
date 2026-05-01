import { createCredentialTokenGetter } from '@epicenter/auth/node';
import {
	attachAwareness,
	attachSync,
	attachTables,
	createPeerDirectory,
	defineMutation,
	defineQuery,
	defineTable,
	PeerIdentity,
	toWsUrl,
} from '@epicenter/workspace';
import { type } from 'arktype';
import Type from 'typebox';
import * as Y from 'yjs';

const SERVER_URL = 'https://api.epicenter.so';
const WORKSPACE_ID = 'epicenter.notes-repro';

// `_v: '1'` here is arktype syntax for the literal NUMBER 1 (numeric strings
// in arktype's type position resolve to number literals). The `set()` call
// below passes `_v: 1`: same value, two different syntax conventions.
const Note = defineTable(type({ id: 'string', body: 'string', _v: '1' }));

export function openNotes(peer: PeerIdentity) {
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

	const awareness = attachAwareness(ydoc, {
		schema: { peer: PeerIdentity },
		initial: { peer },
	});
	const sync = attachSync(ydoc, {
		url: toWsUrl(`${SERVER_URL}/workspaces/${ydoc.guid}`),
		getToken: createCredentialTokenGetter({ serverOrigin: SERVER_URL }),
		awareness,
	});
	const peerDirectory = createPeerDirectory({ awareness, sync });
	const rpc = sync.attachRpc(actions);

	return {
		workspaceId: ydoc.guid,
		actions,
		awareness,
		peerDirectory,
		rpc,
		sync,
		whenReady: sync.whenConnected,
		async [Symbol.asyncDispose]() {
			ydoc.destroy();
			await sync.whenDisposed;
		},
	};
}
