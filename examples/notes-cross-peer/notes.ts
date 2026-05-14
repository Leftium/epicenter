import { createMachineAuthClient, requireSession } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachTables,
	defineMutation,
	defineQuery,
	defineTable,
	openCollaboration,
	websocketUrl,
} from '@epicenter/workspace';
import { type } from 'arktype';
import Type from 'typebox';
import * as Y from 'yjs';

const WORKSPACE_ID = 'epicenter.notes-repro';

// `_v: '1'` here is arktype syntax for the literal NUMBER 1 (numeric strings
// in arktype's type position resolve to number literals). The `set()` call
// below passes `_v: 1`: same value, two different syntax conventions.
const Note = defineTable(type({ id: 'string', body: 'string', _v: '1' }));

export async function openNotes(replicaId: string) {
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

	const auth = await createMachineAuthClient();
	const session = requireSession(auth);
	const collaboration = openCollaboration(ydoc, {
		url: websocketUrl(`${EPICENTER_API_URL}/workspaces/${ydoc.guid}`),
		openWebSocket: session.openWebSocket,
		replicaId,
		actions,
	});

	return {
		workspaceId: ydoc.guid,
		actions,
		collaboration,
		whenReady: collaboration.whenConnected,
		async [Symbol.asyncDispose]() {
			ydoc.destroy();
			await collaboration.whenDisposed;
		},
	};
}
