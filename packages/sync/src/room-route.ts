import type { OwnerId } from '@epicenter/identity';

const stripTrailing = (s: string) => s.replace(/\/+$/, '');

/**
 * Wire route for a workspace sync room: `/api/owners/:ownerId/rooms/:roomId`.
 *
 * Single source of truth shared by the workspace client (which builds the URL
 * in transport.ts) and the sync server (which registers the pattern). It is
 * part of the sync wire contract, so it lives in `@epicenter/sync` alongside
 * the message protocol and the auth subprotocol. The URL string is durable:
 * production clients hit it today, so the shape must not change.
 */
export const ROOM_ROUTE = {
	pattern: '/api/owners/:ownerId/rooms/:roomId',
	prefixPattern: '/api/owners/:ownerId/rooms/*',
	url: (baseURL: string, ownerId: OwnerId, roomId: string) =>
		`${stripTrailing(baseURL)}/api/owners/${encodeURIComponent(ownerId)}/rooms/${encodeURIComponent(roomId)}`,
} as const;
