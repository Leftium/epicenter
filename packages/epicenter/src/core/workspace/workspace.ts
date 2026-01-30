/**
 * Workspace definition types for YJS-first collaborative workspaces.
 *
 * This module provides:
 * - {@link defineWorkspace} - Type inference helper for workspace definitions
 * - {@link WorkspaceDefinition} - The workspace definition type (name, tables, kv)
 *
 * ## Usage
 *
 * Use `defineWorkspace` to create type-safe workspace definitions:
 *
 * ```typescript
 * const definition = defineWorkspace({
 *   name: 'My Blog',
 *   description: 'Personal blog workspace',
 *   icon: 'emoji:📝',
 *   tables: [
 *     table({ id: 'posts', name: 'Posts', fields: [id(), text({ id: 'title' })] }),
 *   ],
 *   kv: [
 *     select({ id: 'theme', options: ['light', 'dark'] }),
 *   ],
 * });
 * ```
 *
 * To create a workspace client, use `createCellWorkspace` from `@epicenter/hq/cell`:
 *
 * ```typescript
 * import { createCellWorkspace } from '@epicenter/hq/cell';
 *
 * const workspace = createCellWorkspace({
 *   headDoc,
 *   definition: { name: 'Blog', tables: {...} },
 * }).withExtensions({ persistence });
 * ```
 *
 * ## Related Modules
 *
 * - {@link ../docs/workspace-doc.ts} - WorkspaceDoc type definition
 * - {@link ../../cell/index.ts} - Cell workspace API (createCellWorkspace)
 *
 * @module
 */

import type {
	Field,
	Icon,
	KvField,
	TableDefinition,
} from '../schema/fields/types';

// ─────────────────────────────────────────────────────────────────────────────
// Public API: Types
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Definition Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Complete workspace definition using arrays for tables and kv.
 *
 * The standard format where:
 * - `tables` is an array of `TableDefinition` (each with its own `id`)
 * - `kv` is an array of `KvField` (the field's `id` serves as the key)
 *
 * @example
 * ```typescript
 * const definition = defineWorkspace({
 *   name: 'My Blog',
 *   description: 'Personal blog workspace',
 *   icon: 'emoji:📝',
 *   tables: [
 *     table({ id: 'posts', name: 'Posts', fields: [id(), text({ id: 'title' }), select({ id: 'status', options: ['draft', 'published'] })] }),
 *   ],
 *   kv: [
 *     select({ id: 'theme', name: 'Theme', options: ['light', 'dark'] }),
 *     integer({ id: 'fontSize', name: 'Font Size', default: 14 }),
 *   ],
 * });
 * ```
 */
export type WorkspaceDefinition<
	TTableDefinitions extends readonly TableDefinition<
		readonly Field[]
	>[] = TableDefinition<readonly Field[]>[],
	TKvFields extends readonly KvField[] = KvField[],
> = {
	/** Display name of the workspace */
	name: string;
	/** Description of the workspace */
	description: string;
	/** Icon for the workspace - tagged string format 'type:value' or null */
	icon: Icon | null;
	/** Table definitions as array (each TableDefinition has its own id) */
	tables: TTableDefinitions;
	/** KV fields directly (no wrapper, field.id is the key) */
	kv: TKvFields;
};

/**
 * Type inference helper for workspace definitions.
 *
 * Applies defaults for optional fields:
 * - `description` defaults to empty string
 * - `icon` defaults to null
 *
 * @example
 * ```typescript
 * const definition = defineWorkspace({
 *   name: 'Blog',
 *   tables: [table({ id: 'posts', name: 'Posts', fields: [id(), text({ id: 'title' })] })],
 *   kv: [select({ id: 'theme', options: ['light', 'dark'] })],
 * });
 * ```
 */
export function defineWorkspace<
	const TTableDefinitions extends readonly TableDefinition<readonly Field[]>[],
	const TKvFields extends readonly KvField[],
>(
	definition: WorkspaceDefinition<TTableDefinitions, TKvFields> & {
		description?: string;
	},
): WorkspaceDefinition<TTableDefinitions, TKvFields> {
	return {
		name: definition.name,
		description: definition.description ?? '',
		icon: definition.icon ?? null,
		tables: definition.tables,
		kv: definition.kv,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Y.Doc Structure: Three Top-Level Maps
// ─────────────────────────────────────────────────────────────────────────────
//
// HEAD DOC (per workspace, all epochs)
// Y.Map('meta') - Workspace identity
//   └── name: string
//   └── icon: Icon | null
//   └── description: string
// Y.Map('epochs') - Epoch tracking
//   └── [clientId]: number
//
// WORKSPACE DOC (per epoch)
// Y.Map('definition') - Table/KV definitions (rarely changes)
//   └── tables: Y.Map<tableName, { name, icon, description, fields }>
//   └── kv: Y.Map<keyName, { name, icon, description, field }>
//
// Y.Map('kv') - Settings values (changes occasionally)
//   └── [key]: value
//
// Y.Map('tables') - Table data (changes frequently)
//   └── [tableName]: Y.Map<rowId, Y.Map<fieldName, value>>
//
// This enables:
// - Independent observation (no observeDeep needed)
// - Different persistence strategies per map
// - Collaborative definition editing via Y.Map('definition')
// - Workspace identity (name/icon) shared across all epochs
//
// See specs/20260121T231500-doc-architecture-v2.md for details.
