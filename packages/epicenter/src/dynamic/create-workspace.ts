/**
 * Dynamic Workspace Factory
 *
 * Creates a unified workspace client with optional HeadDoc support.
 *
 * Architecture:
 * - Cell-level CRDT storage (one Y.Array per table)
 * - External schema with validation (definition passed in)
 * - Optional HeadDoc for time travel and epochs
 * - Builder pattern for type-safe extension setup
 *
 * Y.Doc structure:
 * ```
 * Y.Doc
 * +-- Y.Array('table:posts')  <- Table data (cells only)
 * +-- Y.Array('table:users')  <- Another table
 * +-- Y.Array('kv')           <- Workspace-level key-values
 * ```
 *
 * @packageDocumentation
 */

import * as Y from 'yjs';
import { defineExports, type Lifecycle } from '../core/lifecycle';
import type { YKeyValueLwwEntry } from '../core/utils/y-keyvalue-lww';
import type {
	ExtensionContext,
	ExtensionFactoryMap,
	InferExtensionExports,
	WorkspaceBuilder,
} from './extensions';
import { validateId } from './keys';
import {
	createKvStore,
	KV_ARRAY_NAME,
	TABLE_ARRAY_PREFIX,
} from './stores/kv-store';
import { createTableHelper } from './table-helper';
import type {
	CellValue,
	CreateWorkspaceOptions,
	TableDef,
	TableHelper,
	WorkspaceClient,
} from './types';

/**
 * Get a table by its ID from an array of tables.
 */
function getTableById(
	tables: readonly TableDef[],
	tableId: string,
): TableDef | undefined {
	return tables.find((t) => t.id === tableId);
}

/**
 * Create a Dynamic Workspace with optional HeadDoc support.
 *
 * Returns a builder that allows adding extensions with typed context.
 *
 * @example Without HeadDoc (simple, GC enabled)
 * ```typescript
 * import { createWorkspace } from '@epicenter/hq/dynamic';
 *
 * const client = createWorkspace({
 *   id: 'my-workspace',
 *   definition,
 * }).withExtensions({
 *   persistence,
 *   sqlite,
 * });
 * ```
 *
 * @example With HeadDoc (time travel enabled, GC disabled)
 * ```typescript
 * import { createWorkspace, createHeadDoc } from '@epicenter/hq/dynamic';
 *
 * const headDoc = createHeadDoc({
 *   workspaceId: 'my-workspace',
 *   providers: { persistence },
 * });
 *
 * await headDoc.whenSynced;
 *
 * const client = createWorkspace({
 *   id: 'my-workspace',
 *   definition,
 *   headDoc,
 * }).withExtensions({
 *   persistence,
 *   sqlite,
 * });
 * ```
 */
export function createWorkspace<TTableDefs extends readonly TableDef[]>(
	options: CreateWorkspaceOptions & {
		definition: { tables: TTableDefs };
	},
): WorkspaceBuilder<TTableDefs> {
	const { definition, headDoc, ydoc: existingYdoc, id: workspaceId } = options;

	// Determine epoch based on HeadDoc presence
	const epoch = headDoc ? headDoc.getEpoch() : 0;

	// Create Y.Doc with appropriate GUID and GC settings
	const ydoc = existingYdoc ?? createWorkspaceYDoc(workspaceId, headDoc);

	// Extract metadata from definition
	const name = definition.name;
	const description = definition.description ?? '';
	const icon = definition.icon ?? null;

	// Cache table helpers to avoid recreation
	const tableHelperCache = new Map<string, TableHelper>();

	// Initialize KV store with validation from definition
	const kvArray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_ARRAY_NAME);
	const kv = createKvStore(kvArray, definition.kv ?? []);

	/**
	 * Get or create a table helper.
	 */
	function table(tableId: string): TableHelper {
		validateId(tableId, 'tableId');

		let helper = tableHelperCache.get(tableId);
		if (!helper) {
			const yarray = ydoc.getArray<YKeyValueLwwEntry<CellValue>>(
				`${TABLE_ARRAY_PREFIX}${tableId}`,
			);
			// Use schema from definition, or empty schema for dynamic tables
			const tableSchema = getTableById(definition.tables, tableId) ?? {
				id: tableId,
				name: tableId,
				description: '',
				icon: null,
				fields: [],
			};
			helper = createTableHelper(tableId, yarray, tableSchema);
			tableHelperCache.set(tableId, helper);
		}
		return helper;
	}

	return {
		withExtensions<TExtensions extends ExtensionFactoryMap<TTableDefs>>(
			extensionFactories: TExtensions,
		): WorkspaceClient<TTableDefs, InferExtensionExports<TExtensions>> {
			// Initialize extensions with typed context
			const extensions = {} as InferExtensionExports<TExtensions>;

			for (const [extensionId, factory] of Object.entries(extensionFactories)) {
				const context: ExtensionContext<TTableDefs> = {
					ydoc,
					workspaceId,
					epoch,
					table: table as ExtensionContext<TTableDefs>['table'],
					kv,
					definition: definition as ExtensionContext<TTableDefs>['definition'],
					extensionId,
				};
				(extensions as Record<string, unknown>)[extensionId] = defineExports(
					factory(context),
				);
			}

			// Aggregate whenSynced from all extensions
			const whenSynced = Promise.all(
				Object.values(extensions).map((e) => (e as Lifecycle).whenSynced),
			).then(() => {});

			const client: WorkspaceClient<
				TTableDefs,
				InferExtensionExports<TExtensions>
			> = {
				// Identity
				id: workspaceId,
				epoch,
				ydoc,

				// Metadata
				name,
				description,
				icon,
				definition: definition as WorkspaceClient<TTableDefs>['definition'],

				// Data access
				table: table as WorkspaceClient<TTableDefs>['table'],
				kv,

				// Extensions
				extensions,

				// Lifecycle
				whenSynced,

				batch<T>(
					fn: (
						ws: WorkspaceClient<TTableDefs, InferExtensionExports<TExtensions>>,
					) => T,
				): T {
					// Wraps all operations in a single Y.js transaction:
					// - Observers fire once at the end (not per operation)
					// - All changes sent as single update to sync peers
					// - Values set in batch are readable within same batch
					//
					// YKeyValueLww uses single-writer architecture where set() writes to
					// a `pending` map for immediate reads. See YKeyValueLww.pending.
					return ydoc.transact(() => fn(this));
				},

				async destroy(): Promise<void> {
					await Promise.allSettled(
						Object.values(extensions).map((e) => (e as Lifecycle).destroy()),
					);
					ydoc.destroy();
				},
			};

			return client;
		},
	};
}

/**
 * Create a Y.Doc with appropriate GUID and GC settings based on HeadDoc presence.
 *
 * This is the shared logic used by workspace factories.
 *
 * @param workspaceId - The workspace identifier
 * @param headDoc - Optional HeadDoc for epoch/time-travel support
 * @returns Configured Y.Doc
 */
export function createWorkspaceYDoc(
	workspaceId: string,
	headDoc?: { getEpoch(): number },
): Y.Doc {
	if (headDoc) {
		// Full mode: epoch-suffixed GUID, GC disabled for snapshots
		const epoch = headDoc.getEpoch();
		return new Y.Doc({
			guid: `${workspaceId}-${epoch}`,
			gc: false,
		});
	} else {
		// Simple mode: plain GUID, GC enabled (default)
		return new Y.Doc({
			guid: workspaceId,
		});
	}
}
