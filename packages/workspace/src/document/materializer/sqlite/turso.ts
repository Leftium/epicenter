/**
 * `attachTursoMaterializer(ydoc, { path, tables })`: Turso-backed materializer.
 *
 * Built on `@tursodatabase/database` (Turso's Rust SQLite rewrite, formerly
 * Limbo). The same package powers both native (Bun/Node) via the platform
 * binary and browsers via WebAssembly, so the same call shape works for
 * daemon-side files and for in-memory browser mirrors.
 *
 * Use this when you want vectors (Turso has them; `bun:sqlite` does not),
 * when you need a browser-local mirror, or when you'd rather track the
 * Turso engine than the SQLite project's own pace.
 *
 * `connect()` is async, so the materializer's startup is gated behind
 * {@link AttachTursoMaterializerResult.whenConnected}. Callers wanting the
 * underlying handle await `.client` (a `Promise<Database>`).
 *
 * @example
 * ```ts
 * const materializer = attachTursoMaterializer(ydoc, {
 *   path: ':memory:',                // in-memory; rebuilds from Y.Doc each session
 *   waitFor: idb.whenLoaded,
 *   tables,
 *   fts: { entries: ['title'] },
 * });
 *
 * await materializer.whenFlushed;
 * const client = await materializer.client;
 *
 * // Drizzle wrap (same schema, same query surface as bun:sqlite path):
 * const schema = tablesToDrizzleSchema(definitions);
 * const db = drizzle(client, { schema });   // via your chosen drizzle adapter
 * ```
 *
 * Browser caveat: Turso's WASM build targets `wasm32-wasip1-threads`, which
 * requires cross-origin isolation headers
 * (`Cross-Origin-Opener-Policy: same-origin` +
 * `Cross-Origin-Embedder-Policy: require-corp`) on the host page. Confirm
 * the deployment can set these before shipping a browser bundle that loads
 * this attach function.
 *
 * @module
 */

import { connect, type Database } from '@tursodatabase/database';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import {
	attachSqliteMaterializerCore,
	type FtsConfig,
	type MirrorDatabase,
	type TablesRecord,
} from './core.js';

/**
 * Options for {@link attachTursoMaterializer}.
 */
export type AttachTursoMaterializerOptions<TTables extends TablesRecord> = {
	/**
	 * Path or URL that Turso's `connect()` accepts:
	 *
	 * - `':memory:'`     in-memory; the only path that works in browsers today.
	 * - `'<filepath>'`   local file on disk (Bun/Node).
	 *
	 * On disk, Turso creates the file on demand if missing (no `mkdir` here;
	 * the path's parent directory must already exist if you're not using
	 * `:memory:`).
	 */
	path: string;

	/**
	 * Workspace tables to mirror. Each entry becomes a SQLite table named
	 * after the record key. Pass the whole `tables` record to mirror
	 * everything, or an object literal subset like `{ notes: tables.notes }`
	 * to mirror a strict subset.
	 */
	tables: TTables;

	/**
	 * Optional FTS5 configuration. Keys must match `tables` keys; values
	 * list the columns of that table's row to include in the FTS index.
	 */
	fts?: FtsConfig<TTables>;

	/** Forwarded to the materializer core. Defaults to 100 ms. */
	debounceMs?: number;

	/**
	 * Gate: the materializer awaits this AND the Turso `connect()` before the
	 * initial DDL + full-load runs. Matches the `waitFor` convention used by
	 * `openCollaboration`. Omit for no extra gate.
	 */
	waitFor?: Promise<unknown>;

	/**
	 * Logger for background failures. Defaults to a console-backed logger
	 * with source `attachTursoMaterializer`.
	 */
	log?: Logger;
};

/**
 * Attach a Turso-backed materializer to a Y.Doc.
 *
 * Returns synchronously per the attach-primitive convention. The async
 * `connect()` runs in the background; the materializer core awaits it
 * (folded into `waitFor`) before touching the database. Callers needing the
 * underlying handle await `materializer.client` or wait for
 * `materializer.whenConnected`.
 */
export function attachTursoMaterializer<TTables extends TablesRecord>(
	ydoc: Y.Doc,
	{
		path,
		tables,
		fts,
		debounceMs,
		waitFor,
		log = createLogger('attachTursoMaterializer'),
	}: AttachTursoMaterializerOptions<TTables>,
): ReturnType<typeof attachSqliteMaterializerCore<TTables>> & {
	/** Resolves once Turso's `connect()` has completed. */
	whenConnected: Promise<void>;
	/**
	 * The underlying Turso `Database` handle. Async because `connect()` is
	 * async; most callers `await materializer.whenFlushed` first, by which
	 * point the promise has already resolved.
	 */
	client: Promise<Database>;
} {
	const clientPromise = connect(path);
	const whenConnected = clientPromise.then(() => undefined);

	// MirrorDatabase wrapper. Each call awaits the connect promise then
	// forwards to Turso's `exec` / `prepare`. The materializer body already
	// awaits every MirrorDatabase call, so the extra hop costs only one
	// already-resolved tick per call after the initial connect.
	// Turso's Statement (Promise-returning run/get/all) is structurally
	// compatible with MirrorStatement (MaybePromise-returning), so prepare()
	// can return the native Statement directly. No wrapper.
	const db: MirrorDatabase = {
		async run(sql) {
			const client = await clientPromise;
			await client.exec(sql);
		},
		async prepare(sql) {
			const client = await clientPromise;
			return client.prepare(sql);
		},
	};

	const core = attachSqliteMaterializerCore(ydoc, {
		db,
		tables,
		fts,
		debounceMs,
		waitFor:
			waitFor === undefined
				? whenConnected
				: Promise.all([waitFor, whenConnected]),
		log,
	});

	// Registered after the core's destroy listener so dispose() (which cancels
	// timers and detaches observers) runs first. Closing the client is async;
	// ydoc.destroy is fire-and-forget for listeners, so log on rejection.
	ydoc.once('destroy', () => {
		clientPromise
			.then((client) => client.close())
			.catch((cause: unknown) => {
				log.warn(
					new Error('attachTursoMaterializer: client.close failed', {
						cause,
					}),
				);
			});
	});

	return { ...core, whenConnected, client: clientPromise };
}
