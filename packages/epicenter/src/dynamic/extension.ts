/**
 * Extension types and utilities.
 *
 * Re-exports extension types from workspace/types.ts (the canonical location)
 * plus lifecycle utilities for extension authors.
 *
 * ## Extensions vs Providers
 *
 * - **Providers** (doc-level): True YJS providers for sync/persistence on raw Y.Docs
 *   (Head Doc, Registry Doc). Receive minimal context: `{ ydoc }`.
 *
 * - **Extensions** (workspace-level): Plugins that extend workspaces with features
 *   like SQLite queries, Markdown sync, revision history. Receive the client-so-far
 *   as context, including previously added extensions.
 *
 * Extension factories return `{ exports?, lifecycle?, onDocumentOpen? }`.
 * The framework normalizes defaults internally.
 */

// Re-export lifecycle types for extension authors
export type { Extension, Lifecycle } from '../shared/lifecycle';

// Re-export all extension types from workspace/types.ts (the canonical location)
export type {
	ExtensionContext,
	ExtensionFactory,
} from './workspace/types';
