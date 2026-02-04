/**
 * Reddit Import Entry Point
 *
 * Main API for importing Reddit GDPR exports into the workspace.
 *
 * Usage:
 * ```typescript
 * import { importRedditExport, redditWorkspace } from './ingest/reddit';
 * import { createWorkspace } from 'epicenter/static';
 *
 * // Create workspace client
 * const client = createWorkspace(redditWorkspace);
 *
 * // Import data
 * const stats = await importRedditExport(zipFile, client);
 * console.log(`Imported ${stats.totalRows} rows`);
 * ```
 */

import { createWorkspace } from '../../static/index.js';
import { parseRedditZip } from './parse.js';
import {
	type KvData,
	tableTransforms,
	transformKv,
} from './transform.js';
import { validateRedditExport } from './validation.js';
import { type RedditWorkspace, redditWorkspace } from './workspace.js';

// Re-export workspace definition
export { redditWorkspace, type RedditWorkspace };

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ImportStats = {
	tables: Record<string, number>;
	kv: number;
	totalRows: number;
};

export type ImportProgress = {
	phase: 'parse' | 'validate' | 'transform' | 'insert';
	current: number;
	total: number;
	table?: string;
};

export type ImportOptions = {
	onProgress?: (progress: ImportProgress) => void;
};

/**
 * Create a Reddit workspace client.
 * Helper function to ensure proper typing.
 */
export function createRedditWorkspace() {
	return createWorkspace(redditWorkspace);
}

/** Type of workspace client created from redditWorkspace */
export type RedditWorkspaceClient = ReturnType<typeof createRedditWorkspace>;

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORT FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Import a Reddit GDPR export ZIP file into the workspace.
 *
 * @param input - ZIP file as Blob, File, or ArrayBuffer
 * @param workspace - Reddit workspace client from createWorkspace(redditWorkspace)
 * @param options - Optional progress callback
 * @returns Import statistics
 */
export async function importRedditExport(
	input: Blob | ArrayBuffer,
	workspace: RedditWorkspaceClient,
	options?: ImportOptions,
): Promise<ImportStats> {
	const stats: ImportStats = { tables: {}, kv: 0, totalRows: 0 };

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 1: PARSE
	// ═══════════════════════════════════════════════════════════════════════════
	options?.onProgress?.({ phase: 'parse', current: 0, total: 1 });
	const rawData = await parseRedditZip(input);

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 2: VALIDATE
	// ═══════════════════════════════════════════════════════════════════════════
	options?.onProgress?.({ phase: 'validate', current: 0, total: 1 });
	const data = validateRedditExport(rawData);

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 3 & 4: TRANSFORM + INSERT
	// ═══════════════════════════════════════════════════════════════════════════
	const totalTables = tableTransforms.length;
	let tableIndex = 0;

	// Helper to report progress
	const reportProgress = (tableName: string) => {
		options?.onProgress?.({
			phase: 'transform',
			current: tableIndex,
			total: totalTables,
			table: tableName,
		});
		tableIndex++;
	};

	// ─────────────────────────────────────────────────────────────────────────────
	// ALL TABLES: data-driven transform + insert
	// ─────────────────────────────────────────────────────────────────────────────
	for (const { name, transform } of tableTransforms) {
		reportProgress(name);
		const rows = transform(data);

		// Type assertion: we know table names match workspace.tables keys
		// and transform returns rows matching that table's schema
		const table = workspace.tables[name as keyof typeof workspace.tables] as unknown as {
			batch: (fn: (tx: { set: (row: { id: string }) => void }) => void) => void;
		};
		table.batch((tx) => {
			for (const row of rows) tx.set(row);
		});

		stats.tables[name] = rows.length;
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// KV STORE
	// ─────────────────────────────────────────────────────────────────────────────
	options?.onProgress?.({ phase: 'insert', current: 0, total: 1 });
	const kvData = transformKv(data);
	workspace.kv.batch((tx) => {
		for (const [key, value] of Object.entries(kvData) as [
			keyof KvData,
			KvData[keyof KvData],
		][]) {
			if (value !== null) {
				// Type assertion needed: tx.set expects value matching key's schema,
				// but TypeScript can't narrow KvData[keyof KvData] through the loop
				tx.set(key, value as string & Record<string, string>);
				stats.kv++;
			}
		}
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// DONE
	// ═══════════════════════════════════════════════════════════════════════════
	stats.totalRows =
		Object.values(stats.tables).reduce((a, b) => a + b, 0) + stats.kv;

	return stats;
}

/**
 * Preview a Reddit GDPR export without importing.
 * Returns row counts per table.
 */
export async function previewRedditExport(input: Blob | ArrayBuffer): Promise<{
	tables: Record<string, number>;
	kv: Record<string, boolean>;
	totalRows: number;
}> {
	const rawData = await parseRedditZip(input);
	const data = validateRedditExport(rawData);

	// Compute table row counts using same transforms as import
	const tables: Record<string, number> = {};
	for (const { name, transform } of tableTransforms) {
		tables[name] = transform(data).length;
	}

	// Check which KV fields have values
	const kvData = transformKv(data);
	const kv: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(kvData)) {
		kv[key] = value !== null;
	}

	const totalRows = Object.values(tables).reduce((a, b) => a + b, 0);

	return { tables, kv, totalRows };
}
