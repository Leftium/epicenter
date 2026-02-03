/**
 * Ingest module for importing external data exports.
 *
 * Currently supports:
 * - Reddit GDPR exports
 *
 * @packageDocumentation
 */

// Reddit importer
export {
	importRedditExport,
	previewRedditExport,
	redditWorkspace,
	type RedditWorkspace,
	type ImportStats,
	type ImportProgress,
	type ImportOptions,
} from './reddit/index.js';

// Utilities (for custom importers)
export { CSV, parseCsv, type CsvOptions } from './utils/index.js';
export { ZIP, unpackZip } from './utils/index.js';
