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
 * Telemetry is an INJECTED seam, not a hardcoded write. Each HTTP/WS access
 * calls the deployment's {@link RoomAccessRecorder}: the hosted cloud passes
 * {@link recordRoomAccessOnDb} (a fire-and-forget `durableObjectInstance` upsert
 * on `c.var.db`); the single-partition instance passes none, so the rooms route
 * touches neither `c.var.db` nor `c.var.afterResponseQueue` and composes no
 * Postgres at all (ADR-0073).
 */

import { RequestGuardError } from '@epicenter/constants/request-guard-errors';
import type { OwnerId } from '@epicenter/identity';
import { ROOM_ROUTE } from '@epicenter/sync';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { type Context, Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { createOAuthUnauthorizedResourceResponse } from '../auth/oauth-resource.js';
import { MAX_PAYLOAD_BYTES } from '../constants.js';
import * as schema from '../db/schema/index.js';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';
import { createRequireOwnership } from '../middleware/require-ownership.js';
import { normalizeWebSocketAuth } from '../middleware/websocket-auth.js';
import { doName } from '../owner.js';
import type { OwnershipRule } from '../ownership.js';
import type { Env } from '../types.js';

type Db = NodePgDatabase<typeof schema>;

const log = createLogger('server/rooms');

/**
 * One room access, as the deployment's {@link RoomAccessRecorder} sees it: the
 * owner partition that touched the DO, the room id, its owner-scoped DO name, and
 * (on a read/sync) the post-access storage size. The same shape the cloud's
 * `durableObjectInstance` upsert persists.
 */
export type RoomAccess = {
	ownerId: OwnerId;
	resourceName: string;
	doName: string;
	storageBytes?: number;
};

/**
 * How a deployment records a room access, injected into {@link mountRoomsApp}. The
 * hosted cloud passes {@link recordRoomAccessOnDb}; the single-partition instance
 * passes none and the rooms route stays Postgres-free (ADR-0073). The recorder is
 * synchronous and fire-and-forget: it schedules its own durability (the cloud
 * pushes onto `c.var.afterResponseQueue`) and never blocks the response.
 */
export type RoomAccessRecorder = (c: Context<Env>, access: RoomAccess) => void;

const RoomsTelemetryError = defineErrors({
	DoInstanceUpsertFailed: ({
		cause,
		ownerId,
		doName,
	}: {
		cause: unknown;
		ownerId: OwnerId;
		doName: string;
	}) => ({
		message: 'durableObjectInstance telemetry upsert failed; row dropped',
		cause,
		ownerId,
		doName,
	}),
});

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
 * Fire-and-forget upsert into the platform DO instance table. Records that
 * the owner partition touched the DO and, when available, the post-access
 * storage size. Errors are logged and dropped: this is telemetry, not
 * billing authority. The failure is observable via the `server/rooms`
 * logger so silent telemetry loss surfaces in deployment logs.
 */
async function upsertDoInstance(db: Db, params: RoomAccess): Promise<void> {
	const now = new Date();
	try {
		await db
			.insert(schema.durableObjectInstance)
			.values({
				ownerId: params.ownerId,
				resourceName: params.resourceName,
				doName: params.doName,
				storageBytes: params.storageBytes ?? null,
				lastAccessedAt: now,
				storageMeasuredAt: params.storageBytes != null ? now : null,
			})
			.onConflictDoUpdate({
				target: schema.durableObjectInstance.doName,
				set: {
					lastAccessedAt: now,
					...(params.storageBytes != null && {
						storageBytes: params.storageBytes,
						storageMeasuredAt: now,
					}),
				},
			});
	} catch (cause) {
		log.warn(
			RoomsTelemetryError.DoInstanceUpsertFailed({
				cause,
				ownerId: params.ownerId,
				doName: params.doName,
			}),
		);
	}
}

/**
 * The hosted cloud's {@link RoomAccessRecorder}: schedule a fire-and-forget
 * `durableObjectInstance` upsert on the per-request Postgres handle by pushing it
 * onto the after-response queue (drained after the response). The single-partition
 * instance never passes this, so its rooms route reads no `c.var.db` (ADR-0073).
 */
export const recordRoomAccessOnDb: RoomAccessRecorder = (c, access) => {
	c.var.afterResponseQueue.push(upsertDoInstance(c.var.db, access));
};

/**
 * Build the rooms sub-app around a deployment's {@link RoomAccessRecorder}. URL
 * shape is uniform across deployments; the resolved owner partition arrives on
 * `c.var.ownerId` via the deployment-mounted `requireOwnership` middleware, so
 * handlers stay partition-blind. `recordAccess` is closed over here rather than
 * read off the context, so the instance's no-op recorder erases the telemetry
 * path (and its `c.var.db` read) entirely.
 */
function createRoomsApp(recordAccess: RoomAccessRecorder): Hono<Env> {
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

					recordAccess(c, {
						ownerId: c.var.ownerId,
						resourceName: roomId,
						doName: name,
					});
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

				const { data, storageBytes } = await room.getDoc();
				recordAccess(c, {
					ownerId: c.var.ownerId,
					resourceName: roomId,
					doName: name,
					storageBytes,
				});
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
				const { diff, storageBytes } = synced;

				recordAccess(c, {
					ownerId: c.var.ownerId,
					resourceName: roomId,
					doName: name,
					storageBytes,
				});

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
 *
 * `recordAccess` is the deployment's telemetry seam: the hosted cloud passes
 * {@link recordRoomAccessOnDb}, the single-partition instance omits it (a no-op),
 * so an instance's rooms route reads no `c.var.db` (ADR-0073).
 */
export function mountRoomsApp(
	app: Hono<Env>,
	opts: { ownership: OwnershipRule; recordAccess?: RoomAccessRecorder },
): void {
	app.use(
		ROOM_ROUTE.prefixPattern,
		normalizeWebSocketAuth,
		requireRoomBearer,
		createRequireOwnership(opts.ownership),
	);
	app.route('/', createRoomsApp(opts.recordAccess ?? (() => {})));
}
