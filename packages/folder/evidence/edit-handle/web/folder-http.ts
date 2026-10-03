/**
 * EXPERIMENT: a browser stand-in for the demo folder, over HTTP and one
 * EventSource to `server.ts`. Production `Folder` code is untouched.
 *
 * It implements only the members the demo calls: `tables.todos` `inspect`,
 * `get`, `list`, and `replace`; `files.read` and `files.replace`; and
 * `onFilesChanged`. The real folder methods run on the server.
 *
 * Transport limits, stated plainly:
 * - A save is one request. When the request fails or the response is not
 *   JSON, the save is reported `Unconfirmed`: it may have run.
 * - Hints arrive over one EventSource. They are lossy across reconnects, as
 *   folder hints are anyway; a hint is a reason to read, never a capture.
 * - `inspect` runs here, against the same prepared definition, so a reading
 *   is never taken from the wire. That needs the folder's internal
 *   `inspectSource`: the public contract has no `inspect` without an opened
 *   folder.
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
import { inspectSource } from '../../../src/table.js';
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

	const inspect: TodosTable['inspect'] = (source) =>
		inspectSource(definition.tables.todos.fields, source);

	/** Rebuild a snapshot from its capture and source; the reading is this page's own. */
	const snapshotOf = (wire: WireSnapshot): TodoSnapshot =>
		Object.freeze({ ...wire, ...inspect(wire.source) });

	const todos: Pick<TodosTable, 'inspect' | 'get' | 'list' | 'replace'> = {
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
			if (got.error) return Err(got.error as TableGetError);
			// Absence travels as an explicit `null`, never as a missing key.
			return Ok(got.data === null ? undefined : snapshotOf(got.data));
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
			if (listed.error) return Err(listed.error as FileError);
			return Ok(
				listed.data.map(({ path, result }) => ({
					path,
					result: result.error
						? Err(result.error as TableReadError)
						: Ok(snapshotOf(result.data)),
				})),
			);
		},
		async replace(capture, source) {
			let saved: WireResult<WireSnapshot>;
			try {
				saved = await call('/api/tables/todos/replace', {
					capture: { path: capture.path, sha256: capture.sha256 },
					source,
				});
			} catch (cause) {
				return FileError.Unconfirmed({
					path: capture.path,
					operation: 'replace',
					cause,
				});
			}
			if (saved.error) return Err(saved.error as TableReplaceError);
			return Ok(snapshotOf(saved.data));
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
			if (read.error) return Err(read.error as FileError);
			const file: CapturedFile = Object.freeze({
				path,
				sha256: read.data.sha256,
				bytes: fromBase64(read.data.base64),
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
			if (saved.error) return Err(saved.error as FileError);
			return Ok(Object.freeze({ ...saved.data }));
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
			const answer = (await response.json()) as { error?: string };
			return answer.error;
		},
		/** The text of one demo source file, for the caller snippets. */
		async source(name: string): Promise<string> {
			const response = await fetch(`/api/source/${encodeURIComponent(name)}`);
			return response.ok ? response.text() : `Could not load ${name}`;
		},
	};
}

export type DemoConnection = ReturnType<typeof connectDemoFolder>;
