/**
 * Shared types for the materializer family (sqlite + markdown). Each
 * materializer is generic over a record of materialized workspace tables;
 * `TablesRecord` is the structural bound those generics share and
 * `AnyTable` is the variance-friendly element shape they both pass around
 * internally.
 */

import type { Table } from '../table.js';

/**
 * Variance-friendly handle for a single workspace table whose row type the
 * materializer body doesn't need to know. Used in internal registries that
 * hold heterogeneous tables under one key.
 */
// biome-ignore lint/suspicious/noExplicitAny: variance-friendly element type
export type AnyTable = Table<any>;

/**
 * Structural bound for materializer table inputs: a record mapping table
 * names to materialized `Table<TRow>` instances. Satisfied by
 * `workspace.tables` (which is `Tables<TDefs>`) and by hand-rolled subsets
 * like `{ posts: workspace.tables.posts }`.
 */
export type TablesRecord = Record<string, AnyTable>;
