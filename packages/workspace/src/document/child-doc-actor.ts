/**
 * The child-doc observe loop: a daemon-side actor that hosts a live replica of
 * every row's child doc and watches it.
 *
 * The daemon mount hosts the root Y.Doc on disk and over cloud sync, but a
 * conversation transcript is not a row, it is a separate child doc keyed by the
 * row id (see {@link connectTableChildDocs}, the browser twin that hands the UI
 * `tables.<t>.docs.<field>.open(rowId)`). An always-on actor (ADR-0012/0013)
 * needs those same bodies live so it can watch an unanswered turn and stream a
 * reply into it. This is that loop:
 *
 *  - **enumerate**: read the watched table and, for every row, open its child
 *    doc through the field's single-owner guid deriver (`guidFor`).
 *  - **connect**: each opened body is persisted and synced by `connectBody`, the
 *    node-only wiring injected by the mount coordinator. The loop itself stays
 *    transport-agnostic, so the browser-safe coordinator can call it and a test
 *    drives it with an in-memory connector.
 *  - **observe**: shape each body with the field's declared `layout` and build a
 *    per-body `actor` for it; every transcript transaction calls the actor's
 *    `onChange`. That is the seam V0.3 fills with claim -> stream -> finish.
 *  - **dispose**: a body whose row has been removed is torn down. On root
 *    `ydoc.destroy()` (a daemon shutdown), every hosted body is destroyed and its
 *    teardown awaited, the same cascade {@link connectTableChildDocs} uses.
 *
 * The loop never writes the root table, so its own opens cannot re-trigger the
 * table observer; there is no feedback loop.
 *
 * The app declares nothing about identity or shape here: the table, the field's
 * guid deriver, and the layout all come from the schema, exactly as the browser
 * opener derives them. The app supplies only behavior, the per-body `actor`.
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
 * The declared child-doc layout, narrowed to what the loop needs: shape a body
 * doc and observe its changes. `attachChatTranscript` satisfies this.
 */
export type ObservableChildDocLayout<THandle> = (
	ydoc: Y.Doc,
) => THandle & { observe(callback: () => void): () => void };

/**
 * What an app registers per child-doc field: the behavior the daemon runs on a
 * hosted body. Built once per opened body, it reacts to changes and cleans up on
 * teardown. Both members are optional, so a pure observe-and-host registration
 * is `() => ({})`; V0.3 fills `onChange` with claim -> stream -> finish.
 */
export type ChildDocActorHandle = {
	/** React to a body change (a new message, a token append, a finish write). */
	onChange?(): void;
	/** Clean up when the body is torn down (row removed or shutdown). */
	[Symbol.dispose]?(): void;
};

/** Per-body context handed to a {@link ChildDocActorFactory}. */
export type ChildDocActorContext<TRowId extends string, THandle> = {
	/** The row whose child doc this body is. */
	readonly rowId: TRowId;
	/** The body shaped by the field's declared layout. */
	readonly handle: THandle;
	/** The underlying body Y.Doc, for runtime attachments. */
	readonly ydoc: Y.Doc;
};

/**
 * Build the per-body behavior for one hosted child doc. Invoked once per opened
 * body, so it may close over per-body state (an in-flight generation, the
 * claimed id). The app's only input to the observe loop.
 */
export type ChildDocActorFactory<TRowId extends string, THandle> = (
	context: ChildDocActorContext<TRowId, THandle>,
) => ChildDocActorHandle;

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
	 * Derive a row's child-doc room address. The field's single-owner guid
	 * deriver (`tables.<t>.docs.<field>.guid`), so the actor reads a body at the
	 * same address the browser opener writes it.
	 */
	readonly guidFor: (rowId: TRowId) => string;
	/** Connect (persist + sync) a body doc for a derived guid. Node-only; injected. */
	readonly connectBody: (guid: string) => ConnectedChildDoc;
	/** Shape an opened body into its typed handle (the field's declared layout). */
	readonly layout: ObservableChildDocLayout<THandle>;
	/** Build the per-body behavior. The app's only input. */
	readonly actorFor: ChildDocActorFactory<TRowId, THandle>;
	/**
	 * The root doc whose `destroy` flushes every hosted body, the same cascade
	 * {@link connectTableChildDocs} uses for the browser child-doc caches.
	 */
	readonly rootDoc: Y.Doc;
	readonly log?: Logger;
};

/** The running actor: a drainable whose teardown awaits every hosted body. */
export type ChildDocActor = Drainable & {
	[Symbol.dispose](): void;
};

/**
 * Run the child-doc observe loop over one table field.
 *
 * Transport-agnostic: the loop owns enumeration, observation, and lifecycle, but
 * persistence and sync arrive through the injected `connectBody`, so this body
 * imports no node module. The node-only connector and the schema-driven wiring
 * live in the mount coordinator.
 */
export function attachChildDocActor<TRowId extends string, THandle>(
	config: ChildDocActorConfig<TRowId, THandle>,
): ChildDocActor {
	const { table, guidFor, connectBody, layout, actorFor, rootDoc } = config;
	const log = config.log ?? createLogger('workspace/child-doc-actor');

	type Hosted = {
		body: ConnectedChildDoc;
		actor: ChildDocActorHandle;
		unobserve: () => void;
	};
	const hosted = new Map<TRowId, Hosted>();
	let disposed = false;
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	function open(rowId: TRowId): void {
		if (hosted.has(rowId)) return;
		const body = connectBody(guidFor(rowId));
		const handle = layout(body.ydoc);
		const actor = actorFor({ rowId, handle, ydoc: body.ydoc });
		const unobserve = handle.observe(() => actor.onChange?.());
		hosted.set(rowId, { body, actor, unobserve });
	}

	function close(rowId: TRowId): void {
		const entry = hosted.get(rowId);
		if (entry === undefined) return;
		hosted.delete(rowId);
		// Stop firing onChange, let the actor clean up while the doc is still
		// readable, then destroy the body.
		entry.unobserve();
		entry.actor[Symbol.dispose]?.();
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
		// Tear down every hosted body, then await each connector's teardown so a
		// daemon shutdown cannot drop a body's pending write or socket close.
		const draining = [...hosted.values()].map((entry) => {
			entry.unobserve();
			entry.actor[Symbol.dispose]?.();
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

	// Root destroy cascades the actor's teardown, the same way the root's own
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
