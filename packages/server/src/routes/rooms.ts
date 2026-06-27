/**
 * Rooms sub-app: one room per named Y.Doc, resolved through the injected
 * `Rooms` registry (a Cloudflare Durable Object in the cloud, an in-process
 * `bun:sqlite` room on a Bun host). The route is backend-blind.
 *
 * URL shape (uniform across deployments): `/api/owners/:ownerId/rooms/:roomId`.
 * The deployment mounts auth and `requireOwnership` upstream;
 * `requireOwnership` resolves the partition from `(rule, user.id)`,
 * rejects URL `:ownerId` mismatches at the boundary, and populates
 * `c.var.ownerId` before this handler runs.
 *
 * The Durable Object name is the owner-partitioned identifier produced by
 * {@link doName}; nothing here interpolates strings inline. The DO itself
 * is owner-blind: every connection is identified by the
 * `(userId, nodeId)` pair stamped onto its WebSocket attachment.
 *
 * The route reads neither `c.var.db` nor `c.var.afterResponseQueue`: it records
 * no telemetry, so it composes no Postgres dependency on any deployment.
 */

import { RequestGuardError } from '@epicenter/constants/request-guard-errors';
import { ROOM_ROUTE } from '@epicenter/sync';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import { createOAuthUnauthorizedResourceResponse } from '../auth/oauth-resource.js';
import { MAX_PAYLOAD_BYTES } from '../constants.js';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';
import { createRequireOwnership } from '../middleware/require-ownership.js';
import { normalizeWebSocketAuth } from '../middleware/websocket-auth.js';
import { doName } from '../owner.js';
import type { OwnershipRule } from '../ownership.js';
import type { Env } from '../types.js';

/**
 * Wrap a Uint8Array in a Response with a fresh ArrayBuffer copy. Yjs
 * encoders return views over a larger internal buffer; the copy isolates
 * exactly the bytes that should be sent.
 */
function binaryResponse(data: Uint8Array): Response {
	const body = new ArrayBuffer(data.byteLength);
	new Uint8Array(body).set(data);
	return new Response(body, {
		headers: { 'content-type': 'application/octet-stream' },
	});
}

/**
 * Build the rooms sub-app. URL shape is uniform across deployments; the resolved
 * owner partition arrives on `c.var.ownerId` via the deployment-mounted
 * `requireOwnership` middleware, so handlers stay partition-blind.
 */
function createRoomsApp(): Hono<Env> {
	return new Hono<Env>()
		.get(
			ROOM_ROUTE.pattern,
			describeRoute({
				description: 'Get room doc or upgrade to WebSocket',
				tags: ['rooms'],
			}),
			async (c) => {
				const roomId = c.req.param('roomId');
				const name = doName(c.var.ownerId, roomId);
				const room = c.var.rooms.get(name);

				if (isWebSocketUpgrade(c)) {
					// Validate nodeId presence at the route boundary so the backend
					// can trust it is set. nodeId is the dispatch address
					// `dispatch({ to })` resolves against; a missing one would
					// produce a presence-ghost connection (visible in presence
					// frames but unreachable by dispatch).
					const nodeId = c.req.query('nodeId');
					if (!nodeId) {
						const err = RequestGuardError.MissingNodeId();
						return c.json(err, err.error.status);
					}

					// Identity goes to the backend as data, not stamped into a
					// reconstructed request URL: userId from auth (authoritative,
					// never the client's), nodeId the client's own. The backend
					// performs its runtime-specific accept (see ResolvedRoom).
					return room.handleUpgrade({
						request: c.req.raw,
						userId: c.var.user.id,
						nodeId,
					});
				}

				const { data } = await room.getDoc();
				return binaryResponse(data);
			},
		)
		.post(
			ROOM_ROUTE.pattern,
			describeRoute({
				description: 'Sync room doc',
				tags: ['rooms'],
			}),
			async (c) => {
				const roomId = c.req.param('roomId');
				const name = doName(c.var.ownerId, roomId);

				const body = new Uint8Array(await c.req.raw.arrayBuffer());
				if (body.byteLength > MAX_PAYLOAD_BYTES) {
					return new Response('Payload too large', { status: 413 });
				}

				const room = c.var.rooms.get(name);
				const { data: synced, error } = await room.sync(body);
				if (error) {
					return new Response('Malformed sync body', { status: 400 });
				}
				const { diff } = synced;

				return diff
					? binaryResponse(diff)
					: new Response(null, { status: 204 });
			},
		);
}

/**
 * Bearer auth for the rooms surface, the only WebSocket surface.
 *
 * Same bearer-only resolution as `requireBearerUser`, but a failed WebSocket
 * upgrade is rejected through the runtime's {@link Rooms.rejectUpgrade}: the
 * socket is accepted and immediately closed with `4000 + status` (401 -> 4401
 * permanent, 503 -> 4503 retryable), so the browser receives a close code it
 * can read. A plain HTTP error on an upgrade surfaces only as an opaque failed
 * handshake, which the client cannot tell from a network blip. A failed
 * non-upgrade rooms request (getDoc, sync) still answers with the shared HTTP
 * helper. The serialized error is the close reason; the client branches on
 * `error.name`.
 */
const requireRoomBearer = createMiddleware<Env>(async (c, next) => {
	const { data: user, error } = await c.var.resolveUser(c);
	if (error) {
		if (isWebSocketUpgrade(c)) {
			return c.var.rooms.rejectUpgrade({
				request: c.req.raw,
				code: 4000 + error.status,
				reason: JSON.stringify(error),
			});
		}
		return createOAuthUnauthorizedResourceResponse(c, error);
	}
	c.set('user', user);
	await next();
});

/**
 * Mount the rooms surface on a deployment's server app.
 *
 * Bundles the full request pipeline for the only WebSocket surface:
 * transport normalization, auth, ownership, and the route mount, in one
 * call. Deployments call this once; they do not assemble the chain manually.
 *
 * Order matters. {@link normalizeWebSocketAuth} runs first so that on a
 * browser upgrade the ambient session cookie is dropped and the
 * `bearer.<token>` subprotocol is lifted into `Authorization` before
 * {@link requireRoomBearer} (bearer-only: rooms is for external clients,
 * never cookie-bearing browsers) reads it.
 */
export function mountRoomsApp(
	app: Hono<Env>,
	opts: { ownership: OwnershipRule },
): void {
	app.use(
		ROOM_ROUTE.prefixPattern,
		normalizeWebSocketAuth,
		requireRoomBearer,
		createRequireOwnership(opts.ownership),
	);
	app.route('/', createRoomsApp());
}
