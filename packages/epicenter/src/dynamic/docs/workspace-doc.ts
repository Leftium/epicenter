/**
 * Y.Doc type aliases and constants for Workspace documents.
 *
 * This module contains the low-level Yjs structure definitions for workspace data.
 * For creating workspaces, use `createWorkspace()` from the `workspace` module.
 *
 * @module
 */

import type * as Y from 'yjs';
import type { KvValue } from '../../core/schema/fields/types';

// ─────────────────────────────────────────────────────────────────────────────
// Y.Doc Top-Level Map Names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two top-level Y.Map names in a Workspace Y.Doc.
 *
 * Each workspace epoch has a single Y.Doc with two top-level maps:
 * - `kv`: Settings values (actual KV data)
 * - `tables`: Table data (rows organized by table name)
 *
 * Note: Definitions (table/KV schemas) are stored in static JSON files,
 * NOT in Y.Doc. This keeps Y.Docs lean and focused on data only.
 *
 * Note: Workspace-level identity (name, icon, description) lives in the
 * Head Doc, NOT here. This ensures renaming applies to all epochs.
 *
 * This 1:1 mapping enables independent observation and different persistence
 * strategies per map.
 */
export const WORKSPACE_DOC_MAPS = {
	/** Settings values. Changes occasionally. Persisted to kv.json */
	KV: 'kv',
	/** Table row data. Changes frequently. Persisted to tables.sqlite */
	TABLES: 'tables',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Y.Map Type Aliases
// ─────────────────────────────────────────────────────────────────────────────

/** Y.Map storing cell values for a single row, keyed by column name. */
export type RowYMap = Y.Map<unknown>;

/** Y.Map storing rows for a single table, keyed by row ID. */
export type TableYMap = Y.Map<RowYMap>;

/** Y.Map storing all tables, keyed by table name. */
export type TablesYMap = Y.Map<TableYMap>;

/** Y.Array storing KV values as LWW entries (key, val, ts). */
export type KvYArray = Y.Array<{ key: string; val: KvValue; ts: number }>;
