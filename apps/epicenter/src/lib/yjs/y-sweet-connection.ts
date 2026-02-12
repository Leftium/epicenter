import { createYjsProvider, type YSweetProvider } from '@epicenter/y-sweet';
import * as Y from 'yjs';

type YSweetConnectionConfig = {
	/** Workspace ID (used as Y.Doc guid and room name) */
	workspaceId: string;
	/** Y-Sweet server base URL (e.g., 'http://127.0.0.1:8080') */
	serverUrl: string;
};

type YSweetConnection = {
	ydoc: Y.Doc;
	provider: YSweetProvider;
	whenSynced: Promise<void>;
	destroy: () => void;
};

/**
 * Create a Y.Doc connected to a Y-Sweet server
 * Uses direct mode (no authentication)
 */
export function createYSweetConnection(
	config: YSweetConnectionConfig,
): YSweetConnection {
	const { workspaceId, serverUrl } = config;

	// Create Y.Doc with workspace ID as guid
	const ydoc = new Y.Doc({ guid: workspaceId });

	// Create provider with direct connection info
	const provider = createYjsProvider(ydoc, workspaceId, async () => ({
		url: `${serverUrl.replace('http', 'ws')}/d/${workspaceId}/ws`,
		token: undefined,
	}));

	// Create sync promise
	const whenSynced = new Promise<void>((resolve) => {
		if (provider.status === 'connected') {
			resolve();
		} else {
			const handleStatus = (status: string) => {
				if (status === 'connected') {
					provider.off('connection-status', handleStatus);
					resolve();
				}
			};
			provider.on('connection-status', handleStatus);
		}
	});

	const destroy = () => {
		provider.destroy();
		ydoc.destroy();
	};

	return { ydoc, provider, whenSynced, destroy };
}

/**
 * Get the default Y-Sweet server URL from app settings
 * Falls back to localhost:8080 if not configured
 */
export function getDefaultSyncUrl(): string {
	// TODO: Read from app settings store
	return 'http://127.0.0.1:8080';
}
