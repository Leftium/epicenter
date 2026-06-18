/**
 * The thin CLIENT (ADR-0012/0013): a REPL that does work by WRITING a turn into
 * the synced transcript and OBSERVING the answer stream back. It never makes an
 * HTTP request to the actor; typing a line is literally an edit to a Yjs doc.
 *
 * Run several at once on the same room: each is a peer, and all of them watch the
 * same answer stream in (multi-device live view, no server push API).
 *
 * Run: `bun run src/client.ts`  (after the relay and actor are up)
 */

import { attachChatTranscript } from '@epicenter/workspace/ai';
import { nanoid } from 'nanoid';
import * as readline from 'node:readline';
import * as Y from 'yjs';
import { connectPeer } from './transport';

const ROOM = process.env.ROOM ?? 'demo';
const PORT = process.env.PORT ?? 8787;
const URL = `ws://localhost:${PORT}/${ROOM}`;

const doc = new Y.Doc({ gc: true });
const transcript = attachChatTranscript(doc);
connectPeer({ url: URL, doc });

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	prompt: '> ',
});

// Append-only renderer: print new user turns as they appear (local or remote),
// and stream the latest assistant message's text as it grows.
let seenUsers = 0;
let activeAssistant: string | null = null;
let rendered = 0;
const finished = new Set<string>();

transcript.observe(() => {
	const messages = transcript.read();

	const users = messages.filter((message) => message.role === 'user');
	if (users.length > seenUsers) {
		for (const user of users.slice(seenUsers)) {
			process.stdout.write(`\nyou: ${user.text}\n`);
		}
		seenUsers = users.length;
	}

	const assistant = messages.filter((m) => m.role === 'assistant').at(-1);
	if (!assistant) return;
	if (assistant.id !== activeAssistant) {
		activeAssistant = assistant.id;
		rendered = 0;
		process.stdout.write('assistant: ');
	}
	if (assistant.text.length > rendered) {
		process.stdout.write(assistant.text.slice(rendered));
		rendered = assistant.text.length;
	}
	if (assistant.finish && !finished.has(assistant.id)) {
		finished.add(assistant.id);
		process.stdout.write('\n');
		rl.prompt();
	}
});

rl.on('line', (line) => {
	const content = line.trim();
	if (!content) {
		rl.prompt();
		return;
	}
	// Writing the turn IS the request. No HTTP call anywhere.
	transcript.appendUser({
		id: nanoid(),
		content,
		createdAt: Date.now(),
		generationId: nanoid(),
	});
	// The prompt returns after the answer's `finish` syncs back.
});

console.log(`conversation "${ROOM}" — type a message, Ctrl-C to quit`);
rl.prompt();
