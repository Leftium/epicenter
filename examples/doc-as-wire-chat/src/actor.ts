/**
 * The ACTOR (ADR-0012/0013): the always-on daemon that answers a conversation by
 * writing into the synced transcript doc, not by replying to an HTTP request.
 *
 * It is the production wiring, verbatim: `attachChatTranscript` (the layout) +
 * `attachChatActor` (the per-body behavior) + observe -> onChange. The only thing
 * swapped for the demo is the inference backend: instead of Gemini, we inject a
 * fake `ChatStream` that echoes the user's text character by character. Swapping
 * in a real model later (S5) is this one argument, not a rewrite.
 *
 * Run: `bun run src/actor.ts`  (after the relay is up)
 */

import {
	attachChatActor,
	attachChatTranscript,
	type ChatStream,
} from '@epicenter/workspace/ai';
import { EventType, type StreamChunk } from '@tanstack/ai';
import * as Y from 'yjs';
import { connectPeer } from './transport';

const ROOM = process.env.ROOM ?? 'demo';
const PORT = process.env.PORT ?? 8787;
const URL = `ws://localhost:${PORT}/${ROOM}`;
const AGENT = 'demo-actor';

/**
 * A fake inference backend: take the snapshotted prompt, echo the last user
 * message back, typed out one character at a time so you can watch it stream.
 * Honors the abort signal exactly like a real backend must (S3's durable cancel
 * rides this).
 */
const echoStream: ChatStream = async function* (messages, signal) {
	const last = messages[messages.length - 1];
	const said =
		typeof last?.content === 'string'
			? last.content
			: JSON.stringify(last?.content ?? '');
	const reply = `You said: "${said}". (demo actor: no model, just an echo streamed through the synced doc)`;
	for (const char of reply) {
		if (signal.aborted) return;
		yield {
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: 'm',
			delta: char,
		} as StreamChunk;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
};

const doc = new Y.Doc({ gc: true });
const transcript = attachChatTranscript(doc);
const actor = attachChatActor({ ydoc: doc, startStream: echoStream });

connectPeer({ url: URL, doc, onStatus: (status) => console.log(`[transport] ${status}`) });

// The observe loop: every transcript transaction wakes the actor.
transcript.observe(() => actor.onChange?.());

// Human-readable narration of what the actor sees and writes.
let seenUsers = 0;
const announced = new Set<string>();
transcript.observe(() => {
	const messages = transcript.read();
	const users = messages.filter((message) => message.role === 'user');
	if (users.length > seenUsers) {
		for (const user of users.slice(seenUsers)) {
			console.log(`▸ saw turn: "${user.text}" -> streaming an answer…`);
		}
		seenUsers = users.length;
	}
	const assistant = messages.filter((m) => m.role === 'assistant').at(-1);
	if (assistant?.finish && !announced.has(assistant.id)) {
		announced.add(assistant.id);
		console.log(`✓ finished (${assistant.finish.kind}): "${assistant.text}"`);
	}
});

console.log(`actor up · answering as agent "${AGENT}" · watching room "${ROOM}"`);
