/**
 * `attachYjsSync`: content-doc sync sibling of `openCollaboration`.
 *
 * Pure byte transport for content docs (rich-text bodies, attachments,
 * anything nested under a parent document that syncs independently). No
 * presence, no RPC, no identity. The status/lifecycle surface mirrors the
 * sync portion of `openCollaboration` so app code that gates UI render on
 * `whenConnected` works identically for either primitive.
 */

import type { Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import {
	createSyncSupervisor,
	type OpenWebSocket,
	type SyncStatus,
} from './internal/sync-supervisor.js';

export type AttachYjsSyncConfig = {
	url: string;
	waitFor?: Promise<unknown>;
	openWebSocket?: OpenWebSocket;
	log?: Logger;
};

export type YjsSyncAttachment = {
	readonly status: SyncStatus;
	readonly whenConnected: Promise<void>;
	readonly whenDisposed: Promise<void>;
	onStatusChange(listener: (status: SyncStatus) => void): () => void;
	reconnect(): void;
	goOffline(): void;
};

export function attachYjsSync(
	ydoc: Y.Doc,
	config: AttachYjsSyncConfig,
): YjsSyncAttachment {
	const supervisor = createSyncSupervisor(ydoc, config);
	return {
		get status() {
			return supervisor.status;
		},
		whenConnected: supervisor.whenConnected,
		whenDisposed: supervisor.whenDisposed,
		onStatusChange: supervisor.onStatusChange,
		reconnect: supervisor.reconnect,
		goOffline: supervisor.goOffline,
	};
}
