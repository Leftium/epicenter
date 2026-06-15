/**
 * `bindChildDocs`: marry a workspace's child-doc declarations to a connection.
 *
 * A table declares its collaborative bodies isomorphically with
 * `.childDocs({ name: layout })` (see {@link TableDefinition.childDocs}); the
 * declaration names the shape but carries no connection. This function is the
 * runtime half: given the table definitions, the live workspace, and a
 * {@link ChildDocConnection}, it builds one guid-keyed {@link createChildDocs}
 * cache per declared body and returns a per-row accessor.
 *
 * The accessor takes a **row id**, not a guid: guid derivation moves out of the
 * component and into the binding, owned by the declaration. A row's body guid is
 * `(workspaceId, collection, rowId, field)` (see {@link docGuid}), so the body
 * is derived-1:1 and cascades when the row is deleted (the guid simply stops
 * being reachable).
 *
 * ```ts
 * // isomorphic (create<App>):
 * entries: defineTable({ id, title }).childDocs({ content: attachRichText })
 *
 * // runtime (open<App>Browser, where the connection exists):
 * const childDocs = bindChildDocs({ tables, workspace, connection });
 * using body = childDocs.entries.content.open(entryId);
 * body.observe(rerender);
 *
 * // teardown: one dispose flushes every cache.
 * childDocs[Symbol.dispose]();
 * ```
 *
 * @module
 */

import type * as Y from 'yjs';
import type { Guid } from '../shared/id.js';
import {
	type ChildDocConnection,
	createChildDocs,
} from './create-child-docs.js';
import { docGuid } from './doc-guid.js';
import type { ChildDocLayouts, TableDefinition, TableDefinitions } from './table.js';

/** The lazily-opened handle for one row's body: the layout surface plus the runtime's lifecycle fields. */
type ChildDocHandle<TLayout extends (ydoc: Y.Doc) => object> =
	ReturnType<TLayout> & {
		/** The body's guid (the cache key). */
		readonly guid: Guid;
		/** Resolves once local IndexedDB state has replayed into the doc. */
		readonly whenLoaded: Promise<void>;
		/** Release this open; the doc tears down a grace window after the last release. */
		[Symbol.dispose](): void;
	};

/** Per-row access to one declared body: open it by row id (guid derived internally). */
type ChildDocAccessor<TLayout extends (ydoc: Y.Doc) => object> = {
	/** Lazily open (or refcount-share) the body doc for `rowId`. */
	open(rowId: string): ChildDocHandle<TLayout>;
};

/**
 * The bound accessors: `bound.<table>.<field>.open(rowId)`, plus a top-level
 * dispose that flushes every cache. Tables with no declared bodies map to `{}`.
 */
export type BoundChildDocs<TTables extends TableDefinitions> = {
	[TableName in keyof TTables]: TTables[TableName] extends TableDefinition<
		// biome-ignore lint/suspicious/noExplicitAny: only the layouts param is read here
		any,
		infer TLayouts
	>
		? { [Field in keyof TLayouts]: ChildDocAccessor<TLayouts[Field]> }
		: never;
} & Disposable;

/**
 * Build the runtime child-doc accessors for a workspace from its declarations.
 *
 * @param tables     - the same table-definition map passed to `createWorkspace`;
 *                     read for each table's `childDocLayouts`.
 * @param workspace  - the live workspace; its `ydoc.guid` is the workspace id
 *                     segment of every derived body guid (equals the workspace
 *                     id, so derived guids match what the app stored before).
 * @param connection - pre-bound into every body's local storage + cloud sync.
 */
export function bindChildDocs<TTables extends TableDefinitions>({
	tables,
	workspace,
	connection,
}: {
	tables: TTables;
	workspace: { ydoc: Y.Doc };
	connection: ChildDocConnection;
}): BoundChildDocs<TTables> {
	const childDocs = createChildDocs(connection);
	const workspaceId = workspace.ydoc.guid;
	const caches: Disposable[] = [];

	const bound: Record<string, Record<string, ChildDocAccessor<never>>> = {};
	for (const [collection, definition] of Object.entries(tables)) {
		const accessors: Record<string, ChildDocAccessor<never>> = {};
		const layouts = definition.childDocLayouts as ChildDocLayouts;
		for (const [field, layout] of Object.entries(layouts)) {
			const cache = childDocs(layout);
			caches.push(cache);
			accessors[field] = {
				open(rowId) {
					return cache.open(
						docGuid({ workspaceId, collection, rowId, field }),
					) as never;
				},
			};
		}
		bound[collection] = accessors;
	}

	return Object.assign(bound, {
		[Symbol.dispose]() {
			for (const cache of caches) cache[Symbol.dispose]();
		},
	}) as BoundChildDocs<TTables>;
}
