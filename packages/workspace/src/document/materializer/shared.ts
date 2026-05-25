/**
 * Shared types for the materializer family (sqlite + markdown). Each
 * materializer is generic over a record of materialized workspace tables;
 * `TablesRecord` is the structural bound those generics share.
 */

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous row types in a record
import type { Table } from '../table.js';

/**
 * Structural bound for materializer table inputs: a record mapping table
 * names to materialized `Table<TRow>` instances. Satisfied by
 * `workspace.tables` (which is `Tables<TDefs>`) and by hand-rolled subsets
 * like `{ posts: workspace.tables.posts }`.
 */
// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
export type TablesRecord = Record<string, Table<any>>;
