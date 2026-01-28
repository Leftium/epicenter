/**
 * Dynamic Workspace API for Epicenter
 *
 * A runtime-editable, Notion-like database system with cell-level CRDT granularity.
 * Complements the Static Workspace API for use cases where schemas need to be
 * editable at runtime.
 *
 * @example
 * ```typescript
 * import { createDynamicWorkspace } from 'epicenter/dynamic';
 *
 * // Create workspace
 * const workspace = createDynamicWorkspace({ id: 'my-workspace' });
 *
 * // Create a table
 * workspace.tables.create('posts', { name: 'Blog Posts', icon: '📝' });
 *
 * // Add fields (order is auto-assigned if not specified)
 * workspace.fields.create('posts', 'title', { name: 'Title', type: 'text' });
 * workspace.fields.create('posts', 'published', { name: 'Published', type: 'boolean' });
 *
 * // Add a row (returns the generated rowId)
 * const rowId = workspace.rows.create('posts');
 *
 * // Set cell values
 * workspace.cells.set('posts', rowId, 'title', 'Hello World');
 * workspace.cells.set('posts', rowId, 'published', false);
 *
 * // Read table with all fields
 * const table = workspace.getTableWithFields('posts');
 *
 * // Read rows with cells
 * const rows = workspace.getRowsWithCells('posts');
 *
 * // Cleanup
 * await workspace.destroy();
 * ```
 *
 * @packageDocumentation
 */

// ════════════════════════════════════════════════════════════════════════════
// Factory
// ════════════════════════════════════════════════════════════════════════════

export { createDynamicWorkspace } from './create-dynamic-workspace.js';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export type {
	// Schema types
	CellValue,
	FieldDefinition,
	FieldType,
	RowMeta,
	TableDefinition,
	// Store interfaces
	CellsStore,
	FieldsStore,
	RowsStore,
	TablesStore,
	// Change events
	ChangeEvent,
	ChangeHandler,
	// Helper types
	RowWithCells,
	TableWithFields,
	// Client types
	CreateDynamicWorkspaceOptions,
	DynamicWorkspaceClient,
} from './types.js';

// ════════════════════════════════════════════════════════════════════════════
// Key Utilities (for advanced use cases)
// ════════════════════════════════════════════════════════════════════════════

export {
	cellKey,
	fieldKey,
	generateRowId,
	parseCellKey,
	parseFieldKey,
	parseRowKey,
	rowKey,
	validateId,
} from './keys.js';
