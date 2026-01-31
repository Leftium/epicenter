/**
 * Extension types and utilities.
 *
 * Re-exports extension types from workspace-doc.ts (the canonical location)
 * plus lifecycle utilities for extension authors.
 *
 * ## Extensions vs Providers
 *
 * - **Providers** (doc-level): True YJS providers for sync/persistence on raw Y.Docs
 *   (Head Doc, Registry Doc). Receive minimal context: `{ ydoc }`.
 *
 * - **Extensions** (workspace-level): Plugins that extend workspaces with features
 *   like SQLite queries, Markdown sync, revision history. Receive flattened context
 *   with all workspace data plus extensionId.
 *
 * Use `defineExports()` to wrap your extension's return value for lifecycle normalization.
 */

// Re-export lifecycle utilities for extension authors
export { defineExports, type Lifecycle } from '../core/lifecycle';
// Re-export all extension types from workspace-doc (the canonical location)
export type {
	ExtensionContext,
	ExtensionExports,
	ExtensionFactory,
	ExtensionFactoryMap,
	InferExtensionExports,
} from './docs/workspace-doc';
