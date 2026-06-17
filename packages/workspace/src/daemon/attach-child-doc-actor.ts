/**
 * The child-doc observe loop: a daemon-side actor that hosts a live replica of
 * every row's child doc and observes it.
 *
 * The daemon mount hosts the root Y.Doc on disk and over cloud sync, but a
 * conversation transcript is not a row, it is a separate child doc keyed by the
 * row's id (see `connectTableChildDocs` for the browser twin). An always-on
 * actor (ADR-0012/0013) needs the same docs live so it can watch an unanswered
 * turn and stream a reply into it. This is that loop, as a runtime capability:
 *
 *  - **enumerate**: read the watched table and, for every row, open its child
 *    doc through the field's single-owner guid deriver (`guidFor`).
 *  - **connect**: each opened body is persisted and synced by `connectBody`, the
 *    node-only wiring injected by {@link attachMountChildDocActor}. The actor
 *    itself stays transport-agnostic so it is unit-testable with an in-memory
 *    connector.
 *  - **observe**: shape each body with the declared `layout` and subscribe; every
 *    transcript transaction invokes the optional `onChange` seam. V0.3 fills that
 *    seam with claim -> stream -> finish.
 *  - **dispose**: a body whose row has been removed is torn down. On root
 *    `ydoc.destroy()` (a daemon shutdown), every hosted body is destroyed and its
 *    teardown awaited, exactly as `connectTableChildDocs` cascades off the root.
 *
 * The actor never writes the root table, so its own opens cannot re-trigger the
 * table observer; there is no loop.
 *
 * @module
 */

import { createLogger, type Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import type { Drainable } from '../shared/types.js';

/**
 * A connected child-doc body the actor hosts: a live Y.Doc persisted and synced
 * by the injected connector. `dispose()` destroys the doc, cascading the
 * connector's own teardown; `whenDisposed` resolves once that teardown settles.
 */
export type ConnectedChildDoc = Drainable & {
	readonly ydoc: Y.Doc;
	/** Stop persisting and syncing this body. Cascades from `ydoc.destroy()`. */
	dispose(): void;
};

/**
 * The declared child-doc layout, narrowed to what the actor needs: shape a body
 * doc and observe its changes. `attachChatTranscript` satisfies this.
 */
export type ObservableChildDocLayout<THandle> = (
	ydoc: Y.Doc,
) => THandle & { observe(callback: () => void): () => void };

export type ChildDocActorConfig<TRowId extends string, THandle> = {
	/**
	 * The table whose rows name the child docs to host. Read with `scan()` and
	 * watched with `observe()`; every change reconciles the open set.
	 */
	readonly table: {
		scan(): { readonly rows: ReadonlyArray<{ readonly id: TRowId }> };
		observe(callback: () => void): () => void;
	};
	/**
	 * Derive a row's child-doc room address. This is the field's single-owner
	 * guid deriver (`tables.<t>.docs.<field>.guid`), so the actor reads bodies at
	 * the same address the browser opener writes them.
	 */
	readonly guidFor: (rowId: TRowId) => string;
	/** Connect (persist + sync) a body doc for a derived guid. Node-only; injected. */
	readonly connectBody: (guid: string) => ConnectedChildDoc;
	/** Shape an opened body into its typed handle (the declared child-doc layout). */
	readonly layout: ObservableChildDocLayout<THandle>;
	/**
	 * React to a change on a hosted body (a new message, a token append, a finish
	 * write). Fires once per body transaction; the seam V0.3 fills with claim ->
	 * stream -> finish. Omit for a pure observe-and-host loop.
	 */
	readonly onChange?: (args: {
		rowId: TRowId;
		handle: THandle;
		ydoc: Y.Doc;
	}) => void;
	/**
	 * The root doc whose `destroy` flushes every hosted body, mirroring how
	 * `connectTableChildDocs` cascades child-doc teardown off the root.
	 */
	readonly rootDoc: Y.Doc;
	readonly log?: Logger;
};

/** The running actor: a drainable whose teardown awaits every hosted body. */
export type ChildDocActor = Drainable & {
	[Symbol.dispose](): void;
};

/**
 * Run the child-doc observe loop over a table.
 *
 * Pure coordinator: the actor owns enumeration, observation, and lifecycle, but
 * persistence and sync arrive through the injected `connectBody`, so this body
 * imports no node module and a test drives it with an in-memory connector. The
 * node-only connector and the mount wiring live in
 * {@link attachMountChildDocActor}.
 */
export function attachChildDocActor<TRowId extends string, THandle>(
	config: ChildDocActorConfig<TRowId, THandle>,
): ChildDocActor {
	const { table, guidFor, connectBody, layout, onChange, rootDoc } = config;
	const log = config.log ?? createLogger('workspace/child-doc-actor');

	type Hosted = { body: ConnectedChildDoc; unobserve: () => void };
	const hosted = new Map<TRowId, Hosted>();
	let disposed = false;
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	function open(rowId: TRowId): void {
		if (hosted.has(rowId)) return;
		const body = connectBody(guidFor(rowId));
		const handle = layout(body.ydoc);
		const unobserve = handle.observe(() => {
			onChange?.({ rowId, handle, ydoc: body.ydoc });
		});
		hosted.set(rowId, { body, unobserve });
	}

	function close(rowId: TRowId): void {
		const entry = hosted.get(rowId);
		if (entry === undefined) return;
		hosted.delete(rowId);
		entry.unobserve();
		entry.body.dispose();
	}

	function reconcile(): void {
		if (disposed) return;
		const wanted = new Set(table.scan().rows.map((row) => row.id));
		for (const rowId of wanted) open(rowId);
		// Dispose a hosted body whose conversation row is gone.
		for (const rowId of [...hosted.keys()]) {
			if (!wanted.has(rowId)) close(rowId);
		}
	}

	const unobserveTable = table.observe(() => reconcile());
	reconcile();

	async function dispose(): Promise<void> {
		if (disposed) return;
		disposed = true;
		unobserveTable();
		// Destroy every hosted body, then await each connector's teardown so a
		// daemon shutdown cannot drop a body's pending write or socket close.
		const draining = [...hosted.values()].map((entry) => {
			entry.unobserve();
			entry.body.dispose();
			return entry.body.whenDisposed;
		});
		hosted.clear();
		try {
			await Promise.all(draining);
		} catch (cause) {
			log.warn(new Error('child-doc actor body teardown threw', { cause }));
		} finally {
			resolveDisposed();
		}
	}

	// Root destroy cascades the actor's teardown, exactly as the root's own
	// stores and the browser child-doc caches release on `ydoc.destroy()`.
	rootDoc.once('destroy', () => {
		void dispose();
	});

	return {
		whenDisposed,
		[Symbol.dispose]() {
			void dispose();
		},
	};
}
