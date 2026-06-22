/**
 * Local Books agent workspace contract: the synced room the client agent loop
 * (ADR-0047) and the Local Books data daemon share. The daemon advertises its
 * read models as dispatched actions (see `mount.ts`); the client runs the loop
 * here and dispatches them.
 *
 * Isomorphic: no `bun:sqlite`, no node APIs. The SQLite mirror is the daemon's
 * private data, reached only as a tool result, never synced; this contract holds
 * just the conversation transcripts, whose canonical shape lives in
 * `@epicenter/chat`.
 */

import { conversationsTable } from '@epicenter/chat';
import { defineActions, defineWorkspace } from '@epicenter/workspace';

export const localBooksWorkspace = defineWorkspace({
	id: 'epicenter-local-books',
	name: 'local-books',
	tables: {
		conversations: conversationsTable,
	},
	kv: {},
	actions: () => defineActions({}),
});
