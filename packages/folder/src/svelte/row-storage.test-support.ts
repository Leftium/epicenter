/**
 * One todos row file behind a real `table.edit`, with storage a test drives.
 *
 * Reads see the file as it is when they run and can be made to fail. A write
 * lands, then waits for its reply while replies are held; a scripted `io`
 * outcome writes nothing and fails. A replace of a missing file is
 * `NotFound` and writes nothing. Writes complete in memory: their timing is
 * not storage latency. The returned editor is the owner with its
 * `subscribe` counted, so a test can see how many subscriptions views hold.
 */
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { FolderStorage } from '../boundary.js';
import { hashBytes } from '../capture.js';
import {
	type CreateRowOf,
	defineFolder,
	defineTable,
	field,
	type RowEditor,
} from '../contract.js';
import { FileError } from '../errors.js';
import { createTable } from '../table.js';

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: {
				title: field.string({ minLength: 1 }),
				done: field.boolean(),
			},
		}),
	},
});
export type Todo = CreateRowOf<typeof definition.tables.todos>;
export type TodoEditor = RowEditor<Todo>;

const PATH = 'todos/plan.md';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** A valid row in canonical form, with optional extra header lines after the declared fields. */
export function todo(title: string, body = 'Body.\n', extra = '') {
	return `---\n"title": "${title}"\n"done": false\n${extra}---\n${body}`;
}

export async function openTodo(initial: string | undefined = todo('Plan')) {
	let content: string | undefined = initial;
	let reads = 0;
	let readFault: FileError | undefined;
	let holdingReplies = false;
	const heldReplies: PromiseWithResolvers<void>[] = [];
	const outcomes: ('ok' | 'io')[] = [];
	const writes: string[] = [];
	const unused = () => {
		throw new Error('A row editor does not call this storage method');
	};
	const storage: FolderStorage = {
		async read(path) {
			reads += 1;
			if (readFault !== undefined) return { data: null, error: readFault };
			if (content === undefined) return FileError.NotFound({ path });
			const bytes = encoder.encode(content);
			return Ok({ bytes, sha256: await hashBytes(bytes) });
		},
		async apply(changes) {
			const [change] = changes;
			if (changes.length !== 1 || change?.kind !== 'replace')
				throw new Error('An editor applies one replace');
			const outcome = outcomes.shift() ?? 'ok';
			const missing = content === undefined;
			if (!missing && outcome === 'ok') {
				content = decoder.decode(change.bytes);
				writes.push(content);
			}
			if (holdingReplies) {
				const gate = Promise.withResolvers<void>();
				heldReplies.push(gate);
				await gate.promise;
			}
			if (missing) return FileError.NotFound({ path: PATH });
			if (outcome === 'io')
				return FileError.Io({
					path: PATH,
					operation: 'replace',
					cause: 'disk full',
				});
			return Ok(undefined);
		},
		list: unused,
		children: unused,
		readMany: unused,
		open: unused,
		mkdir: unused,
		rmdir: unused,
	};
	const table = createTable<Todo>(
		{ storage },
		'todos',
		definition.tables.todos.fields,
	);
	const owner = expectOk(await table.edit('plan'));
	let subscriptions = 0;
	const editor: TodoEditor = Object.freeze({
		...owner,
		subscribe(invalidate: () => void) {
			const stop = owner.subscribe(invalidate);
			subscriptions += 1;
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				subscriptions -= 1;
				stop();
			};
		},
	});
	return {
		editor,
		writes,
		disk: () => content,
		reads: () => reads,
		/** How many subscriptions are open on the owner. */
		subscriptions: () => subscriptions,
		/** Another writer changes the file. */
		writeElsewhere(text: string | undefined) {
			content = text;
		},
		/** Reads from now on fail with `error`; `undefined` lets them succeed again. */
		failReads(error: FileError | undefined) {
			readFault = error;
		},
		/** The outcomes of the next writes, in order; later writes succeed. */
		script(...next: ('ok' | 'io')[]) {
			outcomes.push(...next);
		},
		holdReplies() {
			holdingReplies = true;
		},
		heldReplies: () => heldReplies.length,
		/** Let the oldest held write reply. */
		releaseReply() {
			heldReplies.shift()?.resolve();
		},
		releaseReplies() {
			holdingReplies = false;
			for (const gate of heldReplies.splice(0)) gate.resolve();
		},
	};
}

/** Let queued storage replies and settlements run. */
export async function settle() {
	for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
}
