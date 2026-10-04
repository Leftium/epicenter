/**
 * EXPERIMENT: a browser stand-in for the demo folder, over HTTP and one
 * EventSource to `server.ts`. Production `Folder` code is untouched.
 *
 * It implements only the members the demo calls: `tables.todos` `get`,
 * `list`, and `replace`, plus the `inspect` an edit handle interprets rows
 * with; `files.read` and `files.replace`; and `onFilesChanged`. The real
 * folder methods run on the server.
 *
 * Transport limits, stated plainly:
 * - A save is one request. When the request fails or the response is not
 *   JSON, the save is reported `Unconfirmed`: it may have run.
 * - Hints arrive over one EventSource. They are lossy across reconnects, as
 *   folder hints are anyway; a hint is a reason to read, never a capture.
 * - `inspectRow` runs here, against the same prepared definition, so a
 *   reading is never taken from the wire. It needs no opened folder.
 */
import { Err, Ok } from 'wellcrafted/result';
import type { CapturedFile, FileCapture } from '../../../src/capture.js';
import {
	FileError,
	type TableGetError,
	type TableReadError,
	type TableReplaceError,
} from '../../../src/errors.js';
import type { FolderFiles } from '../../../src/files.js';
import type { FolderAccess } from '../../../src/folder.js';
import { inspectRow } from '../../../src/row-text.js';
import type {
	DemoEvent,
	HarnessRequest,
	WireResult,
	WireSnapshot,
} from '../protocol.js';
import { definition } from '../todos.js';

type TodosTable = FolderAccess<typeof definition>['tables']['todos'];
type TodoSnapshot = NonNullable<Awaited<ReturnType<TodosTable['get']>>['data']>;

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

/**
 * The folder stand-in alone. `send` delivers one request to the demo server:
 * `fetch` in the page, or the server's fetch handler directly in a test.
 */
export function createHttpFolder({
	send,
	onFilesChanged,
}: {
	send: (path: string, init?: RequestInit) => Promise<Response>;
	onFilesChanged: (listener: (paths: readonly string[]) => void) => () => void;
}) {
	/** POST a JSON body, or GET without one. Throws when the server did not answer with JSON. */
	async function call<TData>(
		path: string,
		body?: unknown,
	): Promise<WireResult<TData>> {
		const response = await send(
			path,
			body === undefined
				? undefined
				: {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body),
					},
		);
		if (!response.ok) throw new Error(`${path} answered ${response.status}`);
		return (await response.json()) as WireResult<TData>;
	}

	const inspect = (text: string) => inspectRow(definition.tables.todos, text);

	/** Rebuild a snapshot from its capture and text; the reading is this page's own. */
	const snapshotOf = (wire: WireSnapshot): TodoSnapshot =>
		Object.freeze({ ...wire, ...inspect(wire.text) });

	const todos: Pick<TodosTable, 'get' | 'list' | 'replace'> & {
		inspect: typeof inspect;
	} = {
		inspect,
		async get(stem) {
			let got: WireResult<WireSnapshot | null>;
			try {
				got = await call('/api/tables/todos/get', { stem });
			} catch (cause) {
				return FileError.Io({
					path: `todos/${stem}.md`,
					operation: 'read',
					cause,
				});
			}
			const { data: snapshot, error } = got;
			if (error) return Err(error as TableGetError);
			// Absence travels as an explicit `null`, never as a missing key.
			return Ok(snapshot === null ? undefined : snapshotOf(snapshot));
		},
		async list() {
			let listed: WireResult<
				{ path: string; result: WireResult<WireSnapshot> }[]
			>;
			try {
				listed = await call('/api/tables/todos');
			} catch (cause) {
				return FileError.Io({ path: 'todos', operation: 'list', cause });
			}
			const { data: entries, error } = listed;
			if (error) return Err(error as FileError);
			return Ok(
				entries.map(({ path, result: { data, error } }) => ({
					path,
					result: error ? Err(error as TableReadError) : Ok(snapshotOf(data)),
				})),
			);
		},
		async replace(stem, text, options) {
			const path = `todos/${stem}.md`;
			// The wire flattens options into the request, so options the table
			// would refuse are refused here, before anything is sent: a key this
			// page does not forward would otherwise vanish into an unguarded save.
			const supplied: unknown = options;
			if (
				typeof supplied !== 'object' ||
				supplied === null ||
				Array.isArray(supplied)
			)
				return FileError.InvalidPath({
					path,
					reason:
						'Write options are required: pass {} to act on the current row, or { expectedSha256 } to act on reviewed bytes',
				});
			const unknown = Object.keys(supplied).find(
				(key) => key !== 'expectedSha256',
			);
			if (unknown !== undefined)
				return FileError.InvalidPath({
					path,
					reason: `Write options take only expectedSha256, not '${unknown}'`,
				});
			// JSON drops an `undefined` value, which would turn a guard that went
			// missing into an unguarded save. A present guard, inherited or not,
			// is read once and travels, as `null` when it is `undefined`, and the
			// table refuses that.
			const guard =
				'expectedSha256' in supplied
					? { expectedSha256: options.expectedSha256 ?? null }
					: {};
			let saved: WireResult<WireSnapshot>;
			try {
				saved = await call('/api/tables/todos/replace', {
					stem,
					text,
					...guard,
				});
			} catch (cause) {
				return FileError.Unconfirmed({
					path,
					operation: 'replace',
					cause,
				});
			}
			const { data: receipt, error } = saved;
			if (error) return Err(error as TableReplaceError);
			// The receipt is the submitted bytes' address, text, and hash.
			const { sha256 } = receipt;
			return Ok(
				Object.freeze({
					stem,
					path: receipt.path,
					text: receipt.text,
					sha256,
				}),
			);
		},
	};

	const files: Pick<FolderFiles, 'read' | 'replace'> = {
		async read(path) {
			let read: WireResult<{ path: string; sha256: string; base64: string }>;
			try {
				read = await call('/api/files/read', { path });
			} catch (cause) {
				return FileError.Io({ path, operation: 'read', cause });
			}
			const { data: capture, error } = read;
			if (error) return Err(error as FileError);
			const file: CapturedFile = Object.freeze({
				path,
				sha256: capture.sha256,
				bytes: fromBase64(capture.base64),
			});
			return Ok(file);
		},
		async replace(capture, content) {
			const bytes =
				typeof content === 'string' ? encoder.encode(content) : content;
			let saved: WireResult<FileCapture>;
			try {
				saved = await call('/api/files/replace', {
					capture: { path: capture.path, sha256: capture.sha256 },
					base64: toBase64(bytes),
				});
			} catch (cause) {
				return FileError.Unconfirmed({
					path: capture.path,
					operation: 'replace',
					cause,
				});
			}
			const { data: receipt, error } = saved;
			if (error) return Err(error as FileError);
			return Ok(Object.freeze({ ...receipt }));
		},
	};

	return { tables: { todos }, files, onFilesChanged };
}

export type DemoFolder = ReturnType<typeof createHttpFolder>;

export function connectDemoFolder() {
	const hintListeners = new Set<(paths: readonly string[]) => void>();
	const eventListeners = new Set<(event: DemoEvent) => void>();
	/** The latest state-like events, replayed to a panel that subscribes late. */
	const latest = new Map<'session' | 'gates' | 'disk', DemoEvent>();
	const firstSession = Promise.withResolvers<{
		root: string;
		generation: number;
	}>();
	const events = new EventSource('/api/events');
	events.onmessage = (message: MessageEvent<string>) => {
		const event = JSON.parse(message.data) as DemoEvent;
		if (event.type === 'hint')
			for (const listener of [...hintListeners]) listener(event.paths);
		if (event.type === 'session') firstSession.resolve(event);
		if (
			event.type === 'session' ||
			event.type === 'gates' ||
			event.type === 'disk'
		)
			latest.set(event.type, event);
		for (const listener of [...eventListeners]) listener(event);
	};

	return {
		folder: createHttpFolder({
			send: (path, init) => fetch(path, init),
			onFilesChanged(listener) {
				hintListeners.add(listener);
				return () => {
					hintListeners.delete(listener);
				};
			},
		}),
		/** The disposable folder this page was loaded for. */
		session: () => firstSession.promise,
		/** Every server event, for the demo's own panels, after the latest session, gates, and disk. */
		onEvent(listener: (event: DemoEvent) => void) {
			eventListeners.add(listener);
			for (const event of latest.values()) listener(event);
			return () => {
				eventListeners.delete(listener);
			};
		},
		async harness(request: HarnessRequest): Promise<string | undefined> {
			const response = await fetch('/api/harness', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(request),
			});
			const { error: answerError } = (await response.json()) as {
				error?: string;
			};
			return answerError;
		},
		/** The text of one demo source file, for the caller snippets. */
		async source(name: string): Promise<string> {
			const response = await fetch(`/api/source/${encodeURIComponent(name)}`);
			return response.ok ? response.text() : `Could not load ${name}`;
		},
	};
}

export type DemoConnection = ReturnType<typeof connectDemoFolder>;
