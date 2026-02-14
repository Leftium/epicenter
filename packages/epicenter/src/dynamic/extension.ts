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
 * Use `defineExtension()` to wrap your extension's return value, separating lifecycle from exports.
 */

// Re-export lifecycle utilities for extension authors
import {
	defineExtension,
	type Extension,
	type Lifecycle,
} from '../shared/lifecycle';
export { defineExtension, type Extension, type Lifecycle };

// Re-export all extension types from workspace/types.ts (the canonical location)
export type {
	ExtensionContext,
	ExtensionFactory,
} from './workspace/types';
