/**
 * HTTP Sync Plugin — Stateless Document Synchronization
 *
 * Thin Elysia wrapper around `@epicenter/sync-core` HTTP handlers.
 * All sync logic is delegated to sync-core; this plugin handles
 * Elysia-specific concerns (guard, route definitions, response mapping).
 *
 * @see @epicenter/sync-core for the framework-agnostic handlers
 */

import {
	extractBearerToken,
	handleHttpGetDoc,
	handleHttpSync,
	type SyncStorage,
	type TokenVerifier,
} from '@epicenter/sync-core';
import { Elysia } from 'elysia';

// ============================================================================
// Configuration
// ============================================================================

export type HttpSyncPluginConfig = {
	storage: SyncStorage;
	/** Verify a token. Omit for open mode (no auth). */
	verifyToken?: TokenVerifier;
};

// ============================================================================
// Plugin
// ============================================================================

/**
 * Creates an Elysia plugin for stateless HTTP document synchronization.
 *
 * Each request delegates to sync-core handlers which read from storage,
 * compute diffs using pure Yjs functions, and return results.
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
				const result = await handleHttpSync(storage, params.room, body);

				set.status = result.status;
				if (result.body) {
					set.headers['content-type'] = 'application/octet-stream';
				}
				return result.body;
			})
			.get('/:room', async ({ params, set, status }) => {
				const result = await handleHttpGetDoc(storage, params.room);

				if (result.status === 404) {
					return status('Not Found', `Document not found: ${params.room}`);
				}

				set.headers['content-type'] = 'application/octet-stream';
				return result.body;
			}),
	);
}
