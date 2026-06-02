/**
 * Tests for writeRoomOverHttp: the one-shot HTTP room write.
 *
 * A fake `fetch` stands in for the relay: GET returns a doc snapshot, POST
 * captures the body. The tests prove the GET-diff-POST shape (the POSTed update
 * reconstructs the mutation), that an unchanged doc is diffed against the
 * fetched state, and that a non-2xx response throws.
 */

import { decodeSyncRequest } from '@epicenter/sync';
import { asOwnerId } from '@epicenter/identity';
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import type { AuthedFetch } from '../shared/types.js';
import { writeRoomOverHttp } from './http-room-sync.js';

const baseURL = 'https://api.test';
const ownerId = asOwnerId('owner-1');
const guid = 'content-doc-1';

/** A fake relay: serves `snapshot` on GET, records POSTs, replies `postStatus`. */
function fakeRelay({
	snapshot = new Uint8Array(0),
	postStatus = 204,
}: { snapshot?: Uint8Array; postStatus?: number } = {}) {
	const posts: Uint8Array[] = [];
	let getCount = 0;
	const fetch: AuthedFetch = async (_input, init) => {
		const method = init?.method ?? 'GET';
		if (method === 'GET') {
			getCount++;
			return new Response(snapshot as BodyInit);
		}
		posts.push(new Uint8Array(await new Response(init?.body).arrayBuffer()));
		return new Response(null, { status: postStatus });
	};
	return {
		fetch,
		posts,
		get getCount() {
			return getCount;
		},
	};
}

describe('writeRoomOverHttp', () => {
	test('GETs state, applies the mutation, POSTs a diff that reconstructs it', async () => {
		const relay = fakeRelay();

		await writeRoomOverHttp({
			fetch: relay.fetch,
			baseURL,
			ownerId,
			guid,
			mutate: (ydoc) => ydoc.getMap('m').set('k', 'v'),
		});

		expect(relay.getCount).toBe(1);
		expect(relay.posts).toHaveLength(1);

		// The POSTed update, applied to a fresh doc, reproduces the mutation.
		const { update } = decodeSyncRequest(relay.posts[0] as Uint8Array);
		const check = new Y.Doc();
		Y.applyUpdateV2(check, update);
		expect(check.getMap('m').get('k')).toBe('v');
	});

	test('diffs against the fetched snapshot, so only the new change is sent', async () => {
		// Seed a server snapshot that already has `a:1`.
		const server = new Y.Doc();
		server.getMap('m').set('a', 1);
		const snapshot = Y.encodeStateAsUpdateV2(server);
		const relay = fakeRelay({ snapshot });

		await writeRoomOverHttp({
			fetch: relay.fetch,
			baseURL,
			ownerId,
			guid,
			mutate: (ydoc) => ydoc.getMap('m').set('b', 2),
		});

		// Applying the diff onto the ORIGINAL server doc yields both keys, and the
		// diff carries only `b` (it was computed against the fetched state).
		const { update } = decodeSyncRequest(relay.posts[0] as Uint8Array);
		Y.applyUpdateV2(server, update);
		expect(server.getMap('m').get('a')).toBe(1);
		expect(server.getMap('m').get('b')).toBe(2);
	});

	test('throws on a non-2xx snapshot GET', async () => {
		const fetch: AuthedFetch = async () =>
			new Response('nope', { status: 500 });
		await expect(
			writeRoomOverHttp({ fetch, baseURL, ownerId, guid, mutate: () => {} }),
		).rejects.toThrow(/snapshot GET failed/);
	});

	test('throws on a non-2xx sync POST', async () => {
		const relay = fakeRelay({ postStatus: 500 });
		await expect(
			writeRoomOverHttp({
				fetch: relay.fetch,
				baseURL,
				ownerId,
				guid,
				mutate: (ydoc) => ydoc.getMap('m').set('k', 'v'),
			}),
		).rejects.toThrow(/sync POST failed/);
	});
});
