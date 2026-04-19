import type * as Y from 'yjs';

/**
 * PROTOTYPE STUB — demonstrates the attach-sync shape.
 *
 * The real port of the supervisor loop from
 * `packages/workspace/src/extensions/sync/websocket.ts` is Phase 1.6 work.
 */
export type SyncStatus =
	| { phase: 'offline' }
	| { phase: 'connecting'; attempt: number }
	| { phase: 'connected' };

export type SyncAttachment = {
	whenConnected: Promise<void>;
	status: SyncStatus;
	onStatusChange: (listener: (status: SyncStatus) => void) => () => void;
	reconnect: () => void;
	/** Resolves after the ydoc is destroyed and websocket teardown completes. */
	disposed: Promise<void>;
};

export type SyncAttachmentConfig = {
	url: (docId: string) => string;
	getToken?: (docId: string) => Promise<string | null>;
	waitFor?: Promise<unknown>;
};

export function attachSync(
	ydoc: Y.Doc,
	config: SyncAttachmentConfig,
): SyncAttachment {
	const { promise: whenConnected, resolve: resolveConnected } =
		Promise.withResolvers<void>();
	const { promise: disposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	const listeners = new Set<(status: SyncStatus) => void>();
	let status: SyncStatus = { phase: 'offline' };

	function setStatus(next: SyncStatus) {
		status = next;
		for (const listener of listeners) listener(status);
	}

	const bootstrap = Promise.resolve(config.waitFor).then(() => {
		setStatus({ phase: 'connecting', attempt: 0 });
		// TODO(phase-1.6): port supervisor loop + WebSocket handshake + RPC from
		// `packages/workspace/src/extensions/sync/websocket.ts`.
		setStatus({ phase: 'connected' });
		resolveConnected();
	});
	void ydoc; // referenced in the real supervisor loop

	ydoc.once('destroy', async () => {
		try {
			// Real impl: set desired='offline', bump runId, await supervisor loop exit,
			// close websocket, resolve pending RPCs with Disconnected.
			await bootstrap;
			setStatus({ phase: 'offline' });
			listeners.clear();
		} finally {
			resolveDisposed();
		}
	});

	return {
		whenConnected,
		get status() {
			return status;
		},
		onStatusChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		reconnect() {
			// Real impl: bump runId on the supervisor loop.
		},
		disposed,
	};
}

export function toWsUrl(httpUrl: string): string {
	return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}
