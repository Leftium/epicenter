/**
 * Browser persistence provider entry point.
 * Uses IndexedDB via y-indexeddb for YJS document persistence.
 *
 * This file is selected by bundlers when the "browser" condition is matched
 * in package.json exports.
 */
export { indexeddbPersistence, persistence } from './web.js';
