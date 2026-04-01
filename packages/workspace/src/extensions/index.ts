/**
 * Unified extensions export for Epicenter (Node.js/Bun only).
 *
 * Exports persistence extensions and utilities. For browser persistence,
 * use the dedicated subpath export:
 *
 * ```typescript
 * import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
 * ```
 *
 * @example Node.js/Bun usage
 * ```typescript
 * import { persistence } from '@epicenter/workspace/extensions';
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
} from './persistence/sqlite.js';
export { indexeddbPersistence as webPersistence } from './persistence/indexeddb.js';

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR LOGGING (Utility)
// ═══════════════════════════════════════════════════════════════════════════════

export { createIndexLogger } from './error-logger.js';
