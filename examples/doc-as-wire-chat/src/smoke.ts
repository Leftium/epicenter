/**
 * Non-interactive end-to-end check: connect as a peer, write one turn, wait for
 * the actor's `finish` to sync back, print it, exit. Proves observe -> stream ->
 * finish over a real WebSocket with no typing. Used by `bun run smoke` and CI-able.
 *
 * Run: `bun run src/smoke.ts`  (after the relay and actor are up)
 */

import { attachChatTranscript } from '@epicenter/workspace/ai';
import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import { connectPeer } from './transport';

const ROOM = process.env.ROOM ?? 'demo';
const PORT = process.env.PORT ?? 8787;
const URL = `ws://localhost:${PORT}/${ROOM}`;

const doc = new Y.Doc({ gc: true });
const transcript = attachChatTranscript(doc);
connectPeer({ url: URL, doc });

const generationId = nanoid();
const { promise, resolve } = Promise.withResolvers<string>();

transcript.observe(() => {
	const answer = transcript
		.read()
		.find((m) => m.role === 'assistant' && m.id === generationId);
	if (answer?.finish) resolve(answer.text);
});

// Give the sync handshake a beat to settle, then write the turn.
setTimeout(() => {
	transcript.appendUser({
		id: nanoid(),
		content: 'hello over a synced doc',
		createdAt: Date.now(),
		generationId,
	});
}, 300);

const answer = await Promise.race([
	promise,
	new Promise<string>((_, reject) =>
		setTimeout(() => reject(new Error('timeout: no finish within 10s')), 10_000),
	),
]);

console.log('SMOKE OK · streamed answer:', JSON.stringify(answer));
process.exit(0);
