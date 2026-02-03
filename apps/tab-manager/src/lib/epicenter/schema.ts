/**
 * Browser state schema composition.
 *
 * Used by the background workspace for server sync and persistence.
 * The popup reads directly from Chrome APIs, not from Y.Doc.
 */

import type { Tables } from '@epicenter/hq/dynamic';
import { BROWSER_TABLES, type BrowserTables } from './browser.schema';

// Re-export the tables array for workspace definitions
export { BROWSER_TABLES };

/**
 * Type-safe database instance for browser state.
 */
export type BrowserDb = Tables<BrowserTables>;
