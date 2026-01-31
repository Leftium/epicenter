/**
 * Workspace definition types for YJS-first collaborative workspaces.
 *
 * This module re-exports from core/schema for backwards compatibility.
 * The canonical definitions live in core/schema/workspace-definition.ts.
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
 * To create a workspace client, use `createWorkspace` from `@epicenter/hq/dynamic`:
 *
 * ```typescript
 * import { createWorkspace } from '@epicenter/hq/dynamic';
 *
 * const workspace = createWorkspace({
 *   headDoc,
 *   definition: { name: 'Blog', tables: {...} },
 * }).withExtensions({ persistence });
 * ```
 *
 * ## Related Modules
 *
 * - {@link ../docs/workspace-doc.ts} - WorkspaceDoc type definition
 * - {@link ../../dynamic/index.ts} - Dynamic workspace API (createWorkspace)
 *
 * @module
 */

// Re-export from core for backwards compatibility
export type { WorkspaceDefinition } from '../../core/schema/workspace-definition';
export { defineWorkspace } from '../../core/schema/workspace-definition';
export {
	validateWorkspaceDefinition,
	WorkspaceDefinitionSchema,
	WorkspaceDefinitionValidator,
} from '../../core/schema/workspace-definition-validator';

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
