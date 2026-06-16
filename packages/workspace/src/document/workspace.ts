/**
 * Workspace definitions and root Y.Doc construction.
 *
 * `defineWorkspace({ id, tables, kv }).open()` is the app-facing entry point:
 * no connection opens only the root doc for daemon composition, while a browser
 * connection also attaches local storage, sync, wipe, and row child-doc openers.
 *
 * `createWorkspace({ id, tables, kv })` remains the low-level root constructor
 * for package internals and tests:
 *
 * ```ts
 * using workspace = createWorkspace({ id, tables, kv });
 * ```
 *
 * ## Storage
 *
 * Every table and the KV store are constructed as plaintext Yjs-backed
 * stores. The relay is trusted, so `createWorkspace` no longer derives or
 * activates client-side encryption keys.
 *
 * ## Disposal
 *
 * `using workspace` triggers `ydoc.destroy()`, which cascades through every
 * store's `ydoc.once('destroy', ...)` hook. No standalone dispose surface.
 *
 * ## Identity
 *
 * `options.id` is the constructor input; `workspace.ydoc.guid` is the
 * canonical read. By construction they agree, and downstream code should read
 * `workspace.ydoc.guid` only.
 *
 * @module
 */

import * as Y from 'yjs';
import { type ActionRegistry, defineActions } from '../shared/actions.js';
import type { Guid } from '../shared/id.js';
import { assertSafeSegment } from '../shared/safe-segment.js';
import { type ConnectionConfig, connectDoc } from './connect-doc.js';
import { createChildDocs } from './create-child-docs.js';
import { docGuid, docGuidRowId } from './doc-guid.js';
import { KV_KEY, TableKey } from './keys.js';
import { createKv, type Kv, type KvDefinitions } from './kv.js';
import { onLocalUpdate } from './on-local-update.js';
import type { Collaboration } from './open-collaboration.js';
import {
	type ChildDocDeclaration,
	type ChildDocDeclarations,
	createTable,
	type InferTableRow,
	type LayoutOf,
	type TableDefinition,
	type TableDefinitions,
	type Tables,
} from './table.js';
import { wipeLocalStorage } from './wipe-local-storage.js';
import {
	type ObservableKvStore,
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './y-keyvalue/index.js';

export type Workspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = ActionRegistry,
> = {
	readonly ydoc: Y.Doc;
	readonly tables: WorkspaceTables<TTables>;
	readonly kv: Kv<TKv>;
	readonly actions: TActions;
	[Symbol.dispose](): void;
};

/**
 * `satisfies Workspace<...>` as a function: type-check a live workspace bundle
 * while preserving its exact inferred type.
 *
 * Use this when a runtime opener returns `{ ...workspace, ...runtimeExtras }`
 * and direct `satisfies Workspace<...>` would force the caller to restate table,
 * KV, action, or runtime generics that TypeScript can infer from the object.
 * Runtime behavior is identity: the same object is returned unchanged.
 */
export function satisfiesWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry,
	TWorkspace extends Workspace<TTables, TKv, TActions>,
>(workspace: TWorkspace): TWorkspace {
	return workspace;
}

export type CreateWorkspaceOptions<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	/**
	 * Stable workspace identifier. Stamped onto the Y.Doc as `guid`.
	 */
	id: string;

	/** Table definitions to materialize on the workspace root. */
	tables: TTables;

	/** KV definitions to materialize on the workspace root. Pass `{}` for none. */
	kv: TKv;
};

export type WorkspaceActionContext<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	readonly ydoc: Y.Doc;
	/**
	 * The root table handles, each carrying its `.docs.<field>.guid(rowId)`
	 * deriver. Action handlers close over the same guid-owning table path the
	 * rest of the workspace uses, so an action never re-derives a child-doc guid
	 * by hand. No `open`: actions run before any connection, so only the pure
	 * guid half is reachable here (the connected opener is layered later).
	 */
	readonly tables: WorkspaceTables<TTables>;
	readonly kv: Kv<TKv>;
};

export type DefineWorkspaceOptions<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry,
> = CreateWorkspaceOptions<TTables, TKv> & {
	/**
	 * Build the action registry after tables and KV are live, so handlers can
	 * close over the handles they query or mutate.
	 */
	actions?: (workspace: WorkspaceActionContext<TTables, TKv>) => TActions;
};

type ChildDocHandle<TLayout extends (ydoc: Y.Doc) => object> =
	ReturnType<TLayout> & {
		readonly ydoc: Y.Doc;
		readonly guid: Guid;
		readonly whenLoaded: Promise<unknown>;
		[Symbol.dispose](): void;
	};

/**
 * The guid-only entry every `.docs.<field>` exposes: derive a row's child-doc
 * guid without a connection. Pure (workspace id + table + row id + field), so it
 * is available on the unconnected root too, and a daemon reading one body over
 * HTTP derives the same guid the browser opener uses.
 */
type RowDocGuid<TRowId extends string> = {
	guid(rowId: TRowId): Guid;
};

type RowChildDocCache<
	TRowId extends string,
	TLayout extends (ydoc: Y.Doc) => object,
> = RowDocGuid<TRowId> & {
	open(rowId: TRowId): ChildDocHandle<TLayout>;
	[Symbol.dispose](): void;
};

/**
 * The guid-only `.docs` namespace present on every table handle, connected or
 * not. `{}` for a table that declared no child docs.
 */
type TableDocGuids<TTableDefinition extends TableDefinition<any, any>> =
	TTableDefinition extends TableDefinition<
		any,
		infer TDecls extends ChildDocDeclarations
	>
		? {
				[K in keyof TDecls]: RowDocGuid<InferTableRow<TTableDefinition>['id']>;
			}
		: {};

/**
 * The `.docs` namespace a connected table handle gains: one row child-doc cache
 * per declared layout, keyed by field name. Each entry adds `open`/dispose to
 * the guid deriver. Lives one level below the table's CRUD methods, so field
 * names never collide with `set`, `open`, etc. Empty `{}` for a table that
 * declared no child docs.
 */
type TableDocs<TTableDefinition extends TableDefinition<any, any>> =
	TTableDefinition extends TableDefinition<
		any,
		infer TDecls extends ChildDocDeclarations
	>
		? {
				[K in keyof TDecls]: RowChildDocCache<
					InferTableRow<TTableDefinition>['id'],
					LayoutOf<TDecls[K]>
				>;
			}
		: {};

/**
 * The root table map: each table handle plus its guid-only `.docs` namespace.
 * `defineWorkspace(...).open(connection)` upgrades each `.docs.<field>` with
 * `open`/dispose (see {@link ConnectedTables}).
 */
export type WorkspaceTables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: Tables<TTableDefinitions>[K] & {
		readonly docs: TableDocGuids<TTableDefinitions[K]>;
	};
};

export type ConnectedTables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: Tables<TTableDefinitions>[K] & {
		readonly docs: TableDocs<TTableDefinitions[K]>;
	};
};

export type ConnectedWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = ActionRegistry,
> = Omit<Workspace<TTables, TKv, TActions>, 'tables'> & {
	readonly tables: ConnectedTables<TTables>;
	readonly idb: ReturnType<typeof connectDoc>['idb'];
	readonly collaboration: Collaboration<TActions>;
	wipe(): Promise<void>;
};

export type ConnectedWorkspaceContext<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = ActionRegistry,
> = Omit<Workspace<TTables, TKv, TActions>, 'tables'> & {
	readonly tables: ConnectedTables<TTables>;
};

/**
 * What an `open(connection, compose)` runtime builder returns: the final action
 * registry plus any runtime-only handles the app wants on the bundle.
 *
 * `actions` is required, not optional: a runtime builder is exactly where
 * browser-only actions get layered onto the base registry, and that returned
 * registry is the one collaboration serves for cross-device dispatch. Returning
 * `{ actions: workspace.actions }` (the base, unchanged) is the explicit way to
 * say "no new actions" — there is no implicit fallback to guess at.
 */
export type WorkspaceRuntimeExtension<
	TActions extends ActionRegistry = ActionRegistry,
> = {
	readonly actions: TActions;
	[Symbol.dispose]?(): void;
};

type ConnectedWorkspaceWithRuntime<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TRuntime extends WorkspaceRuntimeExtension,
> = ConnectedWorkspace<TTables, TKv, TRuntime['actions']> &
	Omit<TRuntime, 'actions' | typeof Symbol.dispose>;

export type WorkspaceDefinition<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = ActionRegistry,
> = {
	readonly id: string;
	readonly tables: TTables;
	readonly kv: TKv;
	open(): Workspace<TTables, TKv, TActions>;
	open(
		connection: ConnectionConfig,
	): ConnectedWorkspace<TTables, TKv, TActions>;
	open<TRuntime extends WorkspaceRuntimeExtension>(
		connection: ConnectionConfig,
		compose: (
			workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>,
		) => TRuntime,
	): ConnectedWorkspaceWithRuntime<TTables, TKv, TRuntime>;
};

/** The unconnected root workspace returned by `definition.open()`. */
export type WorkspaceFromDefinition<TDefinition> =
	TDefinition extends WorkspaceDefinition<
		infer TTables,
		infer TKv,
		infer TActions
	>
		? Workspace<TTables, TKv, TActions>
		: never;

/**
 * Build a fully wired workspace bundle:
 * `{ ydoc, tables, kv, actions, [Symbol.dispose] }`.
 *
 * Step by step:
 *   1. Construct `new Y.Doc({ guid: id, gc: true })`.
 *   2. For each table definition and for the KV slot: build a YKV store
 *      over `ydoc.getArray(...)`, hook `ydoc.once('destroy', dispose)`,
 *      and return the bare plaintext store.
 *   3. Wrap with `createTable` / `createKv` for the typed surfaces.
 *   4. `[Symbol.dispose]()` calls `ydoc.destroy()`, which fires every
 *      registered destroy hook in turn.
 */
export function createWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(options: CreateWorkspaceOptions<TTables, TKv>): Workspace<TTables, TKv, {}> {
	assertSafeSegment(options.id, 'workspace id');
	const ydoc = new Y.Doc({
		guid: options.id,
		gc: true,
	});

	/**
	 * Build one store for a single workspace slot (one table, or the KV
	 * singleton). Each store is a bare YKV over a raw `Y.Array`.
	 *
	 * Every store hooks `ydoc.once('destroy', ...)` so a single `ydoc.destroy()`
	 * (triggered by `using` scope exit or an explicit
	 * `[Symbol.dispose]()`) cascades through every store.
	 */
	function attachStore(arrayKey: string): ObservableKvStore<unknown> {
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(arrayKey);
		const ykv = new YKeyValueLww<unknown>(yarray);
		ydoc.once('destroy', () => ykv[Symbol.dispose]());
		return ykv;
	}

	const tables = Object.fromEntries(
		Object.entries(options.tables).map(([name, definition]) => {
			const table = createTable(attachStore(TableKey(name)), definition, name);
			// `.docs` carries one guid deriver per declared child-doc field, so the
			// workspace owns guid derivation end-to-end. The connected opener layers
			// `open`/dispose onto these same entries (see `connectTableChildDocs`).
			const docs: Record<string, unknown> = {};
			for (const field of Object.keys(definition.childDocDecls)) {
				docs[field] = {
					guid: (rowId: string): Guid =>
						docGuid({
							workspaceId: options.id,
							collection: name,
							rowId,
							field,
						}),
				};
			}
			return [name, { ...table, docs }];
		}),
	) as WorkspaceTables<TTables>;

	const kv = createKv(attachStore(KV_KEY), options.kv);

	return satisfiesWorkspace({
		ydoc,
		tables,
		kv,
		actions: defineActions({}),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	});
}

/**
 * Define an isomorphic workspace model, then open it for a runtime.
 *
 * Three products, selected by arity:
 *
 *   open()                    Bare root: Y.Doc + tables + KV + actions. No
 *                             persistence, no sync, no child-doc openers. Daemon
 *                             and test runtimes take this and attach their own
 *                             storage/transport around it.
 *   open(connection)          The browser preset: the bare root plus IndexedDB
 *                             persistence, the WebSocket relay (see `connectDoc`),
 *                             per-row child-doc openers
 *                             (`tables.notes.docs.body.open(rowId)`), and `wipe()`.
 *   open(connection, compose) The browser preset plus a runtime layer. `compose`
 *                             runs after the doc and child docs are built but
 *                             before collaboration wires, so the action registry
 *                             it returns is the one served for cross-device
 *                             dispatch. That ordering is why `compose` is a
 *                             callback here, not a step you run after `open()`.
 *
 * The connected path is a curated bundle of the lower primitives
 * (`createWorkspace` + `connectTableChildDocs` + `connectDoc` + `createChildDocs`).
 * Non-browser runtimes compose those directly instead of taking the preset.
 */
export function defineWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = {},
>(
	options: DefineWorkspaceOptions<TTables, TKv, TActions>,
): WorkspaceDefinition<TTables, TKv, TActions> {
	function open(): Workspace<TTables, TKv, TActions>;
	function open(
		connection: ConnectionConfig,
	): ConnectedWorkspace<TTables, TKv, TActions>;
	function open<TRuntime extends WorkspaceRuntimeExtension>(
		connection: ConnectionConfig,
		compose: (
			workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>,
		) => TRuntime,
	): ConnectedWorkspaceWithRuntime<TTables, TKv, TRuntime>;
	function open(
		connection?: ConnectionConfig,
		compose?: (
			workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>,
		) => WorkspaceRuntimeExtension,
	) {
		// Phase A: build the parts. Runs for every overload.
		const workspace = createWorkspace({
			id: options.id,
			tables: options.tables,
			kv: options.kv,
		});
		const actions =
			options.actions === undefined
				? ({} as TActions)
				: options.actions(workspace);

		// open(): bare root. Non-browser runtimes wrap this with their own infra.
		if (connection === undefined) {
			return satisfiesWorkspace({
				...workspace,
				actions,
				[Symbol.dispose]() {
					workspace[Symbol.dispose]();
				},
			});
		}

		// Phase B: connect the per-row child-doc openers, then run the caller's
		// composer. compose sees live tables/ydoc/base actions; the `actions` it
		// returns is final. No composer means serve the base actions unchanged.
		const { tables, disposeChildDocs } = connectTableChildDocs({
			tables: workspace.tables,
			definitions: options.tables,
			connection,
		});
		const runtime = compose?.({
			...workspace,
			tables,
			actions,
		}) ?? { actions };
		const connectedActions = runtime.actions;
		// Phase C: solder infrastructure on top of what compose returned.
		// connectDoc serves `connectedActions` to peers, so it must run after compose.
		const { idb, collaboration } = connectDoc(workspace.ydoc, connection, {
			actions: connectedActions,
		});

		let disposed = false;
		function dispose() {
			if (disposed) return;
			disposed = true;
			runtime[Symbol.dispose]?.();
			disposeChildDocs();
			workspace[Symbol.dispose]();
		}

		return satisfiesWorkspace({
			...workspace,
			...runtime,
			tables,
			actions: connectedActions,
			idb,
			collaboration,
			async wipe() {
				dispose();
				await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
				await wipeLocalStorage({
					server: connection.server,
					ownerId: connection.ownerId,
				});
			},
			[Symbol.dispose]: dispose,
		});
	}

	return {
		id: options.id,
		tables: options.tables,
		kv: options.kv,
		open,
	};
}

function connectTableChildDocs<TTableDefinitions extends TableDefinitions>({
	tables,
	definitions,
	connection,
}: {
	tables: WorkspaceTables<TTableDefinitions>;
	definitions: TTableDefinitions;
	connection: ConnectionConfig;
}): {
	tables: ConnectedTables<TTableDefinitions>;
	disposeChildDocs(): void;
} {
	const childDocs = createChildDocs(connection);
	const disposables: Disposable[] = [];
	const connectedTables: Record<string, unknown> = {};

	for (const [collection, table] of Object.entries(tables)) {
		const definition = definitions[collection as keyof TTableDefinitions]!;
		const guidDerivers = table.docs as Record<string, RowDocGuid<string>>;
		// A body's only cross-doc writer: a local edit bumps a recency column on
		// the row. Typed loosely here because the loop has erased the per-table row
		// type; `onLocalEdit` is checked against the real row at the `.childDocs(...)`
		// call site.
		const updateRow = (
			table as { update: (id: string, patch: object) => unknown }
		).update;
		const docs: Record<string, unknown> = {};

		for (const [field, declaration] of Object.entries(
			definition.childDocDecls,
		) as [string, ChildDocDeclaration][]) {
			const layout =
				typeof declaration === 'function' ? declaration : declaration.layout;
			const onLocalEdit =
				typeof declaration === 'function' ? undefined : declaration.onLocalEdit;
			// Register the recency observer once per shared body Y.Doc (in `onBuild`,
			// not per `open`), torn down when the cache evicts the doc. `tx.local`
			// scopes it to local edits, so remote/hydrated updates never bump the
			// row; writing the root row can't re-trigger this child-doc observer, so
			// there is no loop.
			const cache = childDocs(
				layout,
				onLocalEdit
					? {
							onBuild: (ydoc, guid) => {
								const rowId = docGuidRowId(guid);
								return onLocalUpdate(ydoc, () => {
									updateRow(rowId, onLocalEdit(rowId));
								});
							},
						}
					: undefined,
			);
			disposables.push(cache);
			// Reuse the guid deriver the unconnected root already built for this
			// field; the connected handle only ADDS `open`/dispose lifecycle. One
			// owner of derivation end to end: `createWorkspace` (see its `.docs` loop).
			const guidEntry = guidDerivers[field]!;
			docs[field] = {
				...guidEntry,
				open(rowId: string) {
					return cache.open(guidEntry.guid(rowId));
				},
				[Symbol.dispose]() {
					cache[Symbol.dispose]();
				},
			};
		}

		connectedTables[collection] = {
			...table,
			docs,
		};
	}

	return {
		tables: connectedTables as ConnectedTables<TTableDefinitions>,
		disposeChildDocs() {
			for (const disposable of disposables) {
				disposable[Symbol.dispose]();
			}
		},
	};
}
