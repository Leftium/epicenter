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
import { docGuid } from './doc-guid.js';
import { KV_KEY, TableKey } from './keys.js';
import { createKv, type Kv, type KvDefinitions } from './kv.js';
import type { Collaboration } from './open-collaboration.js';
import {
	type ChildDocLayouts,
	createTable,
	type InferTableRow,
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
	readonly tables: Tables<TTables>;
	readonly kv: Kv<TKv>;
	readonly actions: TActions;
	[Symbol.dispose](): void;
};

/**
 * Type-check a live workspace bundle while preserving its exact inferred type.
 *
 * Use this when a runtime opener returns `{ ...workspace, ...runtimeExtras }`
 * and direct `satisfies Workspace<...>` would force the caller to restate table,
 * KV, action, or runtime generics that TypeScript can infer from the object.
 * Runtime behavior is identity: the same object is returned unchanged.
 */
export function defineWorkspaceBundle<
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
	readonly tables: Tables<TTables>;
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

type RowChildDocCache<
	TRowId extends string,
	TLayout extends (ydoc: Y.Doc) => object,
> = {
	open(rowId: TRowId): ChildDocHandle<TLayout>;
	[Symbol.dispose](): void;
};

type TableChildDocs<TTableDefinition extends TableDefinition<any, any>> =
	TTableDefinition extends TableDefinition<
		any,
		infer TLayouts extends ChildDocLayouts
	>
		? {
				[K in keyof TLayouts]: RowChildDocCache<
					InferTableRow<TTableDefinition>['id'],
					TLayouts[K]
				>;
			}
		: {};

export type ConnectedTables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: Tables<TTableDefinitions>[K] &
		TableChildDocs<TTableDefinitions[K]>;
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

export type WorkspaceRuntimeExtension<
	TActions extends ActionRegistry = ActionRegistry,
> = {
	readonly actions?: TActions;
	[Symbol.dispose]?(): void;
};

type RuntimeActions<
	TActions extends ActionRegistry,
	TRuntime extends WorkspaceRuntimeExtension,
> = TRuntime extends { actions: infer TNextActions extends ActionRegistry }
	? TNextActions
	: TActions;

type ConnectedWorkspaceWithRuntime<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry,
	TRuntime extends WorkspaceRuntimeExtension,
> = ConnectedWorkspace<TTables, TKv, RuntimeActions<TActions, TRuntime>> &
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
	): ConnectedWorkspaceWithRuntime<TTables, TKv, TActions, TRuntime>;
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
		Object.entries(options.tables).map(([name, definition]) => [
			name,
			createTable(attachStore(TableKey(name)), definition, name),
		]),
	) as Tables<TTables>;

	const kv = createKv(attachStore(KV_KEY), options.kv);

	return defineWorkspaceBundle({
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
 * Define an isomorphic workspace model and open it for a runtime.
 *
 * `open()` builds only the root Y.Doc, tables, KV, and actions. Daemon mounts
 * can then attach disk-backed infrastructure around that root.
 *
 * `open(connection)` additionally connects the root doc, wires `wipe()`, and
 * adds one child-doc opener to each table handle for every declared
 * `table.childDocs({ field: attachLayout })` layout.
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
	): ConnectedWorkspaceWithRuntime<TTables, TKv, TActions, TRuntime>;
	function open(
		connection?: ConnectionConfig,
		compose?: (
			workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>,
		) => WorkspaceRuntimeExtension,
	) {
		const workspace = createWorkspace({
			id: options.id,
			tables: options.tables,
			kv: options.kv,
		});
		const actions =
			options.actions === undefined
				? ({} as TActions)
				: options.actions(workspace);

		if (connection === undefined) {
			return defineWorkspaceBundle({
				...workspace,
				actions,
				[Symbol.dispose]() {
					workspace[Symbol.dispose]();
				},
			});
		}

		const { tables, disposeChildDocs } = connectTableChildDocs({
			workspaceId: options.id,
			tables: workspace.tables,
			definitions: options.tables,
			connection,
		});
		const runtime =
			compose?.({
				...workspace,
				tables,
				actions,
			}) ?? {};
		const connectedActions = runtime.actions ?? actions;
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

		return defineWorkspaceBundle({
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
	workspaceId,
	tables,
	definitions,
	connection,
}: {
	workspaceId: string;
	tables: Tables<TTableDefinitions>;
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
		const childDocEntries: Record<string, unknown> = {};

		for (const [field, layout] of Object.entries(
			definition.childDocLayouts,
		) as [string, (ydoc: Y.Doc) => object][]) {
			if (RESERVED_TABLE_CHILD_DOC_NAMES.has(field)) {
				throw new Error(
					`Child doc field "${field}" on table "${collection}" conflicts with the table API.`,
				);
			}
			const cache = childDocs(layout);
			disposables.push(cache);
			childDocEntries[field] = {
				open(rowId: string) {
					return cache.open(
						docGuid({
							workspaceId,
							collection,
							rowId,
							field,
						}),
					);
				},
				[Symbol.dispose]() {
					cache[Symbol.dispose]();
				},
			};
		}

		connectedTables[collection] = {
			...table,
			...childDocEntries,
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

const RESERVED_TABLE_CHILD_DOC_NAMES = new Set<string>([
	'name',
	'definition',
	'schema',
	'get',
	'scan',
	'findValid',
	'observe',
	'storedCount',
	'has',
	'set',
	'bulkSet',
	'update',
	'delete',
	'bulkDelete',
	'clear',
]);
