/**
 * Browser state schema — tables, types, and row converters.
 *
 * Central barrel for all schema-related exports.
 */

import type { TablesHelper } from '@epicenter/hq/static';
import type { BrowserTables } from './tables';

export * from './row-converters';
export * from './tables';

/**
 * Type-safe database instance for browser state.
 */
export type BrowserDb = TablesHelper<BrowserTables>;
