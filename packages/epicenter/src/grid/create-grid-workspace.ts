/**
 * Grid Workspace Factory
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
 * +-- Y.Array('posts')    <- Table data (cells only)
 * +-- Y.Array('users')    <- Another table
 * +-- Y.Array('kv')       <- Workspace-level key-values
 * ```
 *
 * @packageDocumentation
 */

import * as Y from 'yjs';
import { defineExports, type Lifecycle } from '../core/lifecycle';
import type { YKeyValueLwwEntry } from '../core/utils/y-keyvalue-lww';
import type {
	GridExtensionContext,
	GridExtensionFactoryMap,
	GridWorkspaceBuilder,
	InferGridExtensionExports,
} from './extensions';
import { createGridTableHelper } from './grid-table-helper';
import { validateId } from './keys';
import { createGridKvStore, KV_ARRAY_NAME } from './stores/kv-store';
import type {
	CellValue,
	CreateGridWorkspaceOptions,
	GridTableDefinition,
	GridTableHelper,
	GridWorkspaceClient,
} from './types';

/**
 * Get a table by its ID from an array of tables.
 */
function getTableById(
	tables: readonly GridTableDefinition[],
	tableId: string,
): GridTableDefinition | undefined {
	return tables.find((t) => t.id === tableId);
}

/**
 * Create a Grid Workspace with optional HeadDoc support.
 *
 * Returns a builder that allows adding extensions with typed context.
 *
 * @example Without HeadDoc (simple, GC enabled)
 * ```typescript
 * const client = createGridWorkspace({
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
 * const headDoc = createHeadDoc({
 *   workspaceId: 'my-workspace',
 *   providers: { persistence },
 * });
 *
 * await headDoc.whenSynced;
 *
 * const client = createGridWorkspace({
 *   id: 'my-workspace',
 *   definition,
 *   headDoc,
 * }).withExtensions({
 *   persistence,
 *   sqlite,
 * });
 * ```
 */
export function createGridWorkspace<
	TTableDefs extends readonly GridTableDefinition[],
>(
	options: CreateGridWorkspaceOptions & {
		definition: { tables: TTableDefs };
	},
): GridWorkspaceBuilder<TTableDefs> {
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
	const tableHelperCache = new Map<string, GridTableHelper>();

	// Initialize KV store
	const kvArray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_ARRAY_NAME);
	const kv = createGridKvStore(kvArray);

	/**
	 * Get or create a table helper.
	 */
	function table(tableId: string): GridTableHelper {
		validateId(tableId, 'tableId');

		let helper = tableHelperCache.get(tableId);
		if (!helper) {
			const yarray = ydoc.getArray<YKeyValueLwwEntry<CellValue>>(tableId);
			// Use schema from definition, or empty schema for dynamic tables
			const tableSchema = getTableById(definition.tables, tableId) ?? {
				id: tableId,
				name: tableId,
				description: '',
				icon: null,
				fields: [],
			};
			helper = createGridTableHelper(tableId, yarray, tableSchema);
			tableHelperCache.set(tableId, helper);
		}
		return helper;
	}

	return {
		withExtensions<TExtensions extends GridExtensionFactoryMap<TTableDefs>>(
			extensionFactories: TExtensions,
		): GridWorkspaceClient<TTableDefs, InferGridExtensionExports<TExtensions>> {
			// Initialize extensions with typed context
			const extensions = {} as InferGridExtensionExports<TExtensions>;

			for (const [extensionId, factory] of Object.entries(extensionFactories)) {
				const context: GridExtensionContext<TTableDefs> = {
					ydoc,
					workspaceId,
					epoch,
					table: table as GridExtensionContext<TTableDefs>['table'],
					kv,
					definition:
						definition as GridExtensionContext<TTableDefs>['definition'],
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

			const client: GridWorkspaceClient<
				TTableDefs,
				InferGridExtensionExports<TExtensions>
			> = {
				// Identity
				id: workspaceId,
				epoch,
				ydoc,

				// Metadata
				name,
				description,
				icon,
				definition: definition as GridWorkspaceClient<TTableDefs>['definition'],

				// Data access
				table: table as GridWorkspaceClient<TTableDefs>['table'],
				kv,

				// Extensions
				extensions,

				// Lifecycle
				whenSynced,

				batch<T>(
					fn: (
						ws: GridWorkspaceClient<
							TTableDefs,
							InferGridExtensionExports<TExtensions>
						>,
					) => T,
				): T {
					// Note: Currently does NOT wrap in a Yjs transaction due to a bug in
					// YKeyValueLww where entries added inside a wrapping transaction are
					// incorrectly deleted by the observer when the transaction completes.
					// TODO: Fix YKeyValueLww observer to properly handle nested transactions.
					return fn(this);
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
 * This is the shared logic used by both Grid and Static workspaces.
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
