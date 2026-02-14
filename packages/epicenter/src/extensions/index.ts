/**
 * Unified extensions export for Epicenter (Node.js/Bun only).
 *
 * All extensions are exported from this module. This export is for server-side
 * use only. For browser persistence, use the conditional export:
 *
 * ```typescript
 * import { persistence } from '@epicenter/hq/extensions/sync/desktop';
 * ```
 *
 * @example Node.js/Bun usage
 * ```typescript
 * import {
 *   sqlite,
 *   markdown,
 *   persistence,  // Desktop/filesystem persistence
 * } from '@epicenter/hq/extensions';
 * ```
 *
 * @example Browser usage (use conditional export)
 * ```typescript
 * // Browser: auto-selects IndexedDB persistence
 * import { indexeddbPersistence } from '@epicenter/hq/extensions/sync/web';
 * ```
 *
 * @packageDocumentation
 */

// ═══════════════════════════════════════════════════════════════════════════════
// PERSISTENCE (Desktop/Node.js only)
// ═══════════════════════════════════════════════════════════════════════════════

export {
	type PersistenceConfig,
	persistence,
} from './sync/desktop.js';
export { indexeddbPersistence as webPersistence } from './sync/web.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SQLITE
// ═══════════════════════════════════════════════════════════════════════════════

export {
	// Re-export Drizzle column builders for SQLite schema customization
	boolean as sqliteBoolean,
	date as sqliteDate,
	id as sqliteId,
	integer as sqliteInteger,
	json as sqliteJson,
	real as sqliteReal,
	type SqliteConfig,
	sqlite,
	tags as sqliteTags,
	text as sqliteText,
} from './sqlite/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
// MARKDOWN
// ═══════════════════════════════════════════════════════════════════════════════

export {
	type BodyFieldSerializerOptions,
	// Serializer factories
	bodyFieldSerializer,
	type DomainTitleFilenameSerializerOptions,
	defaultSerializer,
	defineSerializer,
	// File operations
	deleteMarkdownFile,
	domainTitleFilenameSerializer,
	listMarkdownFiles,
	type MarkdownExtensionConfig,
	MarkdownExtensionErr,
	MarkdownExtensionError,
	type MarkdownOperationError,
	type MarkdownSerializer,
	// Main extension
	markdown,
	type ParsedFilename,
	readMarkdownFile,
	type TableMarkdownConfig,
	type TitleFilenameSerializerOptions,
	titleFilenameSerializer,
	writeMarkdownFile,
} from './markdown/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
// REVISION HISTORY
// ═══════════════════════════════════════════════════════════════════════════════

export {
	type LocalRevisionHistoryConfig,
	localRevisionHistory,
	type VersionEntry,
} from './revision-history/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR LOGGING (Utility)
// ═══════════════════════════════════════════════════════════════════════════════

export { createIndexLogger } from './error-logger.js';
