import type { OwnerId } from '@epicenter/identity';
import { encodeSyncRequest, ROOM_ROUTE } from '@epicenter/sync';
import * as Y from 'yjs';
import type { AuthedFetch } from '../shared/types.js';

/**
 * Durably write to a hosted room over one-shot HTTP: GET the room's current doc,
 * apply `mutate` to a local copy seeded with that state, POST the diff. The relay
 * appends the update durably before responding, so a 2xx is the receipt, with no
 * send buffer to flush and no socket to tear down (the failure mode an ephemeral
 * `openCollaboration` write would hit). Use this for a one-shot write to a
 * relay-only doc; use `openCollaboration` for a live editing session.
 *
 * `mutate` receives a throwaway `Y.Doc` holding the server state, so a diff-based
 * mutation (e.g. `updateYFragment`) merges with concurrent edits. Throws on a
 * non-2xx response.
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
		// Diff since `before` = exactly what `mutate` changed; an empty diff is a
		// safe no-op POST.
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
