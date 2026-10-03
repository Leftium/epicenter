/**
 * EXPERIMENT HARNESS: a disposable in-memory folder for the canonical editor
 * demo. It is not a persistent backend and not `@epicenter/folder`: the
 * files are a `Map` in this page, gone on reload or reset.
 *
 * It implements only what `createCanonicalEditors` takes:
 *
 * - `tables.todos.inspect`: the folder's own `inspectSource` over the demo
 *   definition, so readings and issues are the real conformance check.
 * - `files.read` and `files.overwrite`, with the folder's capture shapes and
 *   error variants.
 * - `onFilesChanged`: a hint after every write that lands, the editor's own
 *   included, as a real folder announces its own saves.
 *
 * Harness controls stand in for what a browser cannot do to a real folder:
 * another program writing or removing a file, a save reply that arrives
 * late or never, and a slow disk. A lost reply is reported only after the
 * bytes landed, so `Unconfirmed` means "it may have completed" honestly.
 */
import { Ok } from 'wellcrafted/result';
import { type CapturedFile, hashBytes } from '../../../src/capture.js';
import { FileError } from '../../../src/errors.js';
import type { FolderFiles } from '../../../src/files.js';
import { inspectSource } from '../../../src/table.js';
import { definition, type TodoRow } from './todos.js';

const encoder = new TextEncoder();
const lenient = new TextDecoder();

export function createMemoryFolder({
	seed,
	log,
}: {
	seed: Readonly<Record<string, string>>;
	/** Where the harness reports what it did, for the page's event log. */
	log: (text: string) => void;
}) {
	const store = new Map<string, Uint8Array>();
	const hintListeners = new Set<(paths: readonly string[]) => void>();
	/** Gates for the next `overwrite`, consumed when it starts. */
	const armed = { holdReply: false, loseReply: false };
	let heldReply: PromiseWithResolvers<void> | undefined;
	let readDelayMs = 0;

	function reseed() {
		store.clear();
		for (const [path, text] of Object.entries(seed))
			store.set(path, encoder.encode(text));
	}
	reseed();

	function announce(path: string, origin: string) {
		log(`Hint for ${path} (${origin})`);
		for (const listener of [...hintListeners]) listener([path]);
	}

	const files: Pick<FolderFiles, 'read' | 'overwrite'> = {
		async read(path) {
			if (readDelayMs > 0)
				await new Promise((resolve) => setTimeout(resolve, readDelayMs));
			const bytes = store.get(path);
			if (bytes === undefined) return FileError.NotFound({ path });
			const file: CapturedFile = Object.freeze({
				path,
				sha256: await hashBytes(bytes),
				bytes: bytes.slice(),
			});
			return Ok(file);
		},
		async overwrite(path, content) {
			const { holdReply, loseReply } = armed;
			armed.holdReply = false;
			armed.loseReply = false;
			const bytes =
				typeof content === 'string' ? encoder.encode(content) : content.slice();
			const sha256 = await hashBytes(bytes);
			store.set(path, bytes);
			log(`Overwrite landed on ${path}: ${sha256.slice(0, 8)}`);
			const held = holdReply ? Promise.withResolvers<void>() : undefined;
			heldReply = held;
			announce(path, 'its own save');
			if (held !== undefined) {
				log('Reply held until Release');
				await held.promise;
			}
			if (loseReply) {
				log('Reply lost: the caller hears Unconfirmed');
				return FileError.Unconfirmed({
					path,
					operation: 'overwrite',
					cause: new Error('The harness dropped this reply'),
				});
			}
			log(`Reply delivered: ${sha256.slice(0, 8)}`);
			return Ok(Object.freeze({ path, sha256 }));
		},
	};

	return {
		/** What `createCanonicalEditors` receives. */
		folder: {
			tables: {
				todos: {
					inspect: (source: string) =>
						inspectSource<TodoRow>(definition.tables.todos.fields, source),
				},
			},
			files,
			onFilesChanged(listener: (paths: readonly string[]) => void) {
				hintListeners.add(listener);
				return () => {
					hintListeners.delete(listener);
				};
			},
		},
		/** The bytes at `path` as text, for display; `undefined` when absent. */
		peek(path: string): string | undefined {
			const bytes = store.get(path);
			return bytes === undefined ? undefined : lenient.decode(bytes);
		},
		/** Another program writes `path`. */
		write(path: string, content: string | Uint8Array) {
			store.set(
				path,
				typeof content === 'string' ? encoder.encode(content) : content,
			);
			announce(path, 'another program wrote it');
		},
		/** Another program removes `path`. */
		remove(path: string) {
			store.delete(path);
			announce(path, 'another program removed it');
		},
		arm(gate: keyof typeof armed, on: boolean) {
			armed[gate] = on;
		},
		isArmed: (gate: keyof typeof armed) => armed[gate],
		isHolding: () => heldReply !== undefined,
		/** Deliver the held reply, or its loss when that was armed too. */
		release() {
			heldReply?.resolve();
			heldReply = undefined;
		},
		setReadDelay(ms: number) {
			readDelayMs = ms;
		},
		/** Put back the seed files and disarm every gate. A held reply is released first. */
		reset() {
			heldReply?.resolve();
			heldReply = undefined;
			armed.holdReply = false;
			armed.loseReply = false;
			reseed();
			log('Harness folder reset to its seed files');
		},
	};
}

export type MemoryFolder = ReturnType<typeof createMemoryFolder>;
