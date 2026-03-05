/**
 * HTTP Sync Plugin — Stateless Document Synchronization
 *
 * Elysia plugin for HTTP-based Yjs document sync. The server never instantiates
 * a Y.Doc — it stores opaque binary updates and uses pure Yjs utility functions
 * (mergeUpdatesV2, diffUpdateV2, encodeStateVectorFromUpdateV2) to compute diffs
 * directly from raw binary blobs.
 *
 * Two endpoints:
 * - POST /:room — Unified sync (push update + pull diff in one round-trip)
 * - GET  /:room — Full snapshot (convenience endpoint)
 *
 * @see ./storage.ts for SyncStorage interface and binary frame encoding
 * @see ./plugin.ts for the WebSocket sync plugin
 */

import { Elysia } from 'elysia';
import * as Y from 'yjs';
import { extractBearerToken } from '../auth';
import {
	decodeSyncRequest,
	type SyncStorage,
	stateVectorsEqual,
} from './storage';

// ============================================================================
// Configuration
// ============================================================================

export type HttpSyncPluginConfig = {
	storage: SyncStorage;
	/** Verify a token. Omit for open mode (no auth). */
	verifyToken?: (token: string) => boolean | Promise<boolean>;
};

// ============================================================================
// Plugin
// ============================================================================

/**
 * Creates an Elysia plugin for stateless HTTP document synchronization.
 *
 * Each request reads from storage, computes diffs using pure Yjs functions,
 * and responds — no in-memory Y.Doc, no room manager, no connection tracking.
 *
 * @param config - Storage backend and optional auth configuration
 * @returns Elysia plugin with POST /:room and GET /:room routes
 */
export function createHttpSyncPlugin(config: HttpSyncPluginConfig) {
	const { storage, verifyToken } = config;

	const restAuth = new Elysia().guard({
		async beforeHandle({ headers, status }) {
			if (!verifyToken) return;
			const token = extractBearerToken(headers.authorization);
			if (!token || !(await verifyToken(token))) {
				return status('Unauthorized', 'Unauthorized');
			}
		},
	});

	return new Elysia().use(
		restAuth
			.post('/:room', async ({ params, request, set }) => {
				const body = new Uint8Array(await request.arrayBuffer());
				const { stateVector: clientSV, update } = decodeSyncRequest(body);

				// Push client update if present
				if (update.byteLength > 0) {
					await storage.appendUpdate(params.room, update);
				}

				// Read all stored updates
				const updates = await storage.getAllUpdates(params.room);
				if (updates.length === 0) {
					set.status = 304;
					return;
				}

				const merged = Y.mergeUpdatesV2(updates);
				const serverSV = Y.encodeStateVectorFromUpdateV2(merged);

				// Client already up to date
				if (stateVectorsEqual(serverSV, clientSV)) {
					set.status = 304;
					return;
				}

				const diff = Y.diffUpdateV2(merged, clientSV);
				set.headers['content-type'] = 'application/octet-stream';
				return diff;
			})
			.get('/:room', async ({ params, set, status }) => {
				const updates = await storage.getAllUpdates(params.room);
				if (updates.length === 0) {
					return status('Not Found', `Document not found: ${params.room}`);
				}

				const merged = Y.mergeUpdatesV2(updates);
				set.headers['content-type'] = 'application/octet-stream';
				return merged;
			}),
	);
}
