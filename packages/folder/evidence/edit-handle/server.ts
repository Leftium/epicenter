/**
 * EXPERIMENT: the edit-handle demo's backend.
 *
 * It owns one disposable directory under the OS temp directory, seeded from
 * `SEED` and opened with `@epicenter/folder/bun`. It reads and writes nothing
 * else. Reset closes that folder, removes the directory, and makes a new one.
 *
 * `createDemoServer()` returns a fetch handler; `dev.ts` mounts it beside
 * Vite. Saves go through the real folder methods (`tables.todos.replace`,
 * `files.replace`) behind the manual gates in `gates.ts`.
 *
 * The other writer is `node:fs` on the same directory, outside the folder
 * handle. The Bun folder does not watch other programs, so after each such
 * write the server sends an explicit `harness` hint. Requests are not
 * serialized: a save held at a gate must not block the writer that races it.
 * Nothing here claims atomicity against arbitrary native writers; the folder
 * checks the captured hash before publishing, best effort, as its README says.
 */
import {
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { openFolder } from '../../src/bun.js';
import { hashBytes } from '../../src/capture.js';
import type { Folder } from '../../src/folder.js';
import { patchSource } from '../../src/markdown.js';
import { pathProblem } from '../../src/paths.js';
import { createPublicationGates } from './gates.js';
import {
	CALLER_SOURCES,
	type DemoEvent,
	type DiskFile,
	type HarnessRequest,
	type WireSnapshot,
} from './protocol.js';
import { definition, SEED } from './todos.js';

type DemoFolder = Folder<typeof definition>;

const PREFIX = 'epicenter-edit-handle-';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** A snapshot's capture and source, without its reading. */
function wire({ path, stem, sha256, source }: WireSnapshot): WireSnapshot {
	return { path, stem, sha256, source };
}

/** JSON with each `Error` reduced to its name and message, so a `cause` survives the trip. */
function json(body: unknown, status = 200): Response {
	return new Response(
		JSON.stringify(body, (_key, value: unknown) =>
			value instanceof Error
				? { name: value.name, message: value.message }
				: value,
		),
		{ status, headers: { 'content-type': 'application/json' } },
	);
}

function base64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

export async function createDemoServer() {
	// Keep the developer's Git configuration (hooks, signing) out of the
	// repository the opener initializes, as the other folder evidence does.
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
	});
	const tempBase = await realpath(tmpdir());
	const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
	let generation = 0;
	let writes = 0;

	function broadcast(event: DemoEvent) {
		const chunk = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
		for (const client of clients) {
			try {
				client.enqueue(chunk);
			} catch {
				clients.delete(client);
			}
		}
	}

	function log(text: string) {
		broadcast({ type: 'log', at: new Date().toISOString(), text });
	}

	const gates = createPublicationGates((event) => {
		switch (event.kind) {
			case 'changed':
				broadcast({ type: 'gates', gates: event.gates });
				return;
			case 'published':
				log(`Published ${event.path} to disk (${event.sha256?.slice(0, 8)})`);
				void broadcastDisk();
				return;
			case 'refused':
				log(`Save of ${event.path} refused: ${event.error}`);
				return;
			case 'replyLost':
				log(`Reply for ${event.path} discarded by the harness`);
				return;
		}
	});

	async function open() {
		const root = await mkdtemp(join(tempBase, PREFIX));
		const opened = await openFolder({
			root,
			definition,
			git: {
				author: { name: 'Edit handle demo', email: 'demo@example.test' },
				commitOnEdit: false,
			},
		});
		if (opened.error) throw new Error(opened.error.message);
		const folder: DemoFolder = opened.data;
		for (const [path, text] of Object.entries(SEED)) {
			const created = await folder.files.create(path, text);
			if (created.error) throw new Error(created.error.message);
		}
		folder.onFilesChanged((paths) => {
			broadcast({ type: 'hint', paths, origin: 'folder' });
			void broadcastDisk();
		});
		generation += 1;
		return { root, folder, generation };
	}

	let session = await open();

	async function readDisk(): Promise<DiskFile[]> {
		const { root } = session;
		const paths = new Set(Object.keys(SEED));
		try {
			for (const name of await readdir(join(root, 'todos')))
				paths.add(`todos/${name}`);
		} catch {
			// No table directory: only the seed paths are listed.
		}
		return Promise.all(
			[...paths].sort().map(async (path): Promise<DiskFile> => {
				let bytes: Uint8Array;
				try {
					bytes = await readFile(join(root, path));
				} catch {
					return { path, state: 'missing' };
				}
				const sha256 = await hashBytes(bytes);
				try {
					return { path, state: 'text', sha256, text: utf8.decode(bytes) };
				} catch {
					return { path, state: 'invalidUtf8', sha256, size: bytes.length };
				}
			}),
		);
	}

	async function broadcastDisk() {
		broadcast({ type: 'disk', files: await readDisk() });
	}

	/** Tell the page a path changed, because the Bun folder will not. */
	function harnessHint(path: string) {
		broadcast({ type: 'hint', paths: [path], origin: 'harness' });
		void broadcastDisk();
	}

	function events(): Response {
		let self: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				self = controller;
				clients.add(controller);
				const hello: DemoEvent[] = [
					{
						type: 'session',
						root: session.root,
						generation: session.generation,
					},
					{ type: 'gates', gates: gates.snapshot() },
				];
				for (const event of hello)
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
					);
				void broadcastDisk();
			},
			cancel() {
				if (self !== undefined) clients.delete(self);
			},
		});
		return new Response(stream, {
			headers: {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
				connection: 'keep-alive',
			},
		});
	}

	async function reset() {
		gates.reset();
		const previous = session;
		session = await open();
		broadcast({
			type: 'session',
			root: session.root,
			generation: session.generation,
		});
		log(`New disposable folder at ${session.root}`);
		await previous.folder.close();
		if (
			previous.root.startsWith(join(tempBase, PREFIX)) &&
			!previous.root.slice(tempBase.length + 1).includes(sep)
		)
			await rm(previous.root, { recursive: true, force: true });
		await broadcastDisk();
	}

	/** Another program edits a row with `node:fs`, never through the folder handle. */
	async function otherWriter(
		path: string,
		change: 'title' | 'body' | 'done',
	): Promise<Response> {
		const { root, folder } = session;
		let text: string;
		try {
			text = utf8.decode(await readFile(join(root, path)));
		} catch (cause) {
			return json(
				{ error: `Cannot read ${path} as text: ${String(cause)}` },
				409,
			);
		}
		const reading = folder.tables.todos.inspect(text);
		writes += 1;
		const patched =
			change === 'title'
				? patchSource(text, {
						fields: { title: `Changed elsewhere #${writes}` },
					})
				: change === 'done'
					? patchSource(text, {
							fields: { done: reading.fields.done !== true },
						})
					: reading.body === undefined
						? undefined
						: patchSource(text, {
								body: `${reading.body}Line added elsewhere #${writes}\n`,
							});
		if (patched === undefined || patched.error)
			return json(
				{
					error: `Cannot change ${change} in ${path}: its source does not take the change`,
				},
				409,
			);
		await writeFile(join(root, path), patched.data);
		log(`Another writer (node:fs) changed ${change} in ${path}`);
		harnessHint(path);
		return json({ ok: true });
	}

	async function harness(request: HarnessRequest): Promise<Response> {
		if ('path' in request && pathProblem(request.path) !== undefined)
			return json({ error: `Refused path ${request.path}` }, 400);
		const { root } = session;
		switch (request.action) {
			case 'reset':
				await reset();
				return json({ ok: true });
			case 'arm':
				gates.arm(request.gate);
				log(`Armed: ${request.gate}`);
				return json({ ok: true });
			case 'release':
				return json({ released: gates.release() });
			case 'write':
				return otherWriter(request.path, request.change);
			case 'remove':
				await rm(join(root, request.path), { force: true });
				log(`Another writer (node:fs) removed ${request.path}`);
				harnessHint(request.path);
				return json({ ok: true });
			case 'corrupt':
				// A fenced file whose second line is not UTF-8.
				await writeFile(
					join(root, request.path),
					new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]),
				);
				log(
					`Another writer (node:fs) wrote bytes that are not UTF-8 to ${request.path}`,
				);
				harnessHint(request.path);
				return json({ ok: true });
			case 'hint':
				log(`Harness hint for ${request.path} (no change made)`);
				harnessHint(request.path);
				return json({ ok: true });
		}
	}

	async function body<T>(request: Request): Promise<T> {
		return (await request.json()) as T;
	}

	async function handle(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === 'GET' && pathname.startsWith('/api/source/')) {
			const name = decodeURIComponent(pathname.slice('/api/source/'.length));
			if (!CALLER_SOURCES.includes(name))
				return new Response('Not a caller source', { status: 404 });
			return new Response(await readFile(join(import.meta.dir, 'web', name)), {
				headers: { 'content-type': 'text/plain; charset=utf-8' },
			});
		}
		const { folder } = session;
		const todos = folder.tables.todos;
		switch (`${request.method} ${pathname}`) {
			case 'GET /api/events':
				return events();
			case 'GET /api/tables/todos': {
				const listed = await todos.list();
				if (listed.error) return json(listed);
				return json({
					data: listed.data.map(({ path, result }) => ({
						path,
						result: result.error
							? result
							: { data: wire(result.data), error: null },
					})),
					error: null,
				});
			}
			case 'POST /api/tables/todos/get': {
				const { stem } = await body<{ stem: string }>(request);
				const got = await todos.get(stem);
				if (got.error) return json(got);
				// Absence is an explicit `null`: JSON drops a key whose value is `undefined`.
				return json({
					data: got.data === undefined ? null : wire(got.data),
					error: null,
				});
			}
			case 'POST /api/tables/todos/replace': {
				const { capture, source } = await body<{
					capture: { path: string; sha256: string };
					source: string;
				}>(request);
				const saved = await gates.run(
					capture.path,
					() => todos.replace(capture, source),
					(receipt) => receipt.sha256,
				);
				if (saved.error) return json(saved);
				return json({ data: wire(saved.data), error: null });
			}
			case 'POST /api/files/read': {
				const { path } = await body<{ path: string }>(request);
				const read = await folder.files.read(path);
				if (read.error) return json(read);
				return json({
					data: {
						path,
						sha256: read.data.sha256,
						base64: base64(read.data.bytes),
					},
					error: null,
				});
			}
			case 'POST /api/files/replace': {
				const { capture, base64: content } = await body<{
					capture: { path: string; sha256: string };
					base64: string;
				}>(request);
				const bytes = new Uint8Array(Buffer.from(content, 'base64'));
				return json(
					await gates.run(
						capture.path,
						() => folder.files.replace(capture, bytes),
						(saved) => saved.sha256,
					),
				);
			}
			case 'POST /api/harness':
				return harness(await body<HarnessRequest>(request));
		}
		return new Response('Not found', { status: 404 });
	}

	return {
		fetch: handle,
		get root() {
			return session.root;
		},
		async close() {
			gates.reset();
			for (const client of clients) client.close();
			clients.clear();
			await session.folder.close();
			await rm(session.root, { recursive: true, force: true });
		},
	};
}
