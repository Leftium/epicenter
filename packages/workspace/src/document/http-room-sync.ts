import type { OwnerId } from '@epicenter/identity';
import { encodeSyncRequest, ROOM_ROUTE } from '@epicenter/sync';
import * as Y from 'yjs';
import type { AuthedFetch } from '../shared/types.js';

// ════════════════════════════════════════════════════════════════════════════
// writeRoomOverHttp: durably write to a hosted room over one-shot HTTP
//
// A one-shot write to a relay-only doc (one with no local persistence and no
// long-lived connection) is a request/response, not a live session. The relay's
// POST sync route applies the update with a synchronous durable append BEFORE it
// responds, so the 2xx IS the durability receipt: there is no send buffer to
// flush and no socket to tear down. This is the honest primitive for that case;
// `openCollaboration` (a live bidirectional session) is for long-lived editing,
// where an ephemeral write would race teardown against the unflushed buffer.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Durably write to a hosted room over one-shot HTTP. GET the room's current
 * doc, apply `mutate` to a local copy seeded with that state, then POST the
 * resulting diff; the relay durably appends it before responding, so a 2xx is
 * the confirmation.
 *
 * `mutate` runs against a throwaway `Y.Doc` already holding the server state, so
 * a diff-based mutation (e.g. y-prosemirror's `updateYFragment`) preserves
 * history and merges with a concurrent edit instead of clobbering it. Throws on
 * any non-2xx response; callers that treat the write as best-effort catch it.
 */
export async function writeRoomOverHttp({
	fetch,
	baseURL,
	ownerId,
	guid,
	mutate,
}: {
	fetch: AuthedFetch;
	baseURL: string;
	ownerId: OwnerId;
	guid: string;
	mutate: (ydoc: Y.Doc) => void;
}): Promise<void> {
	const url = ROOM_ROUTE.url(baseURL, ownerId, guid);

	const snapshotResponse = await fetch(url);
	if (!snapshotResponse.ok) {
		throw new Error(
			`room snapshot GET failed for "${guid}": ${snapshotResponse.status}`,
		);
	}
	const snapshot = new Uint8Array(await snapshotResponse.arrayBuffer());

	const ydoc = new Y.Doc({ guid, gc: true });
	try {
		if (snapshot.byteLength > 0) Y.applyUpdateV2(ydoc, snapshot);
		const before = Y.encodeStateVector(ydoc);
		mutate(ydoc);
		// The diff since `before` is exactly what `mutate` changed (inserts and
		// tombstones). The relay merges it; a no-op mutation encodes an empty diff
		// the relay applies as a no-op, so the POST is always safe to send.
		const update = Y.encodeStateAsUpdateV2(ydoc, before);
		const body = encodeSyncRequest(Y.encodeStateVector(ydoc), update);

		const syncResponse = await fetch(url, {
			method: 'POST',
			body: body as BodyInit,
		});
		if (!syncResponse.ok) {
			throw new Error(
				`room sync POST failed for "${guid}": ${syncResponse.status}`,
			);
		}
	} finally {
		ydoc.destroy();
	}
}
