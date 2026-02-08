/**
 * Reddit Import Entry Point
 *
 * Main API for importing Reddit GDPR exports into the workspace.
 *
 * Architecture:
 *   parse.ts → csv-schemas.ts → workspace
 *
 * The csvSchemas handle validation, parsing, and transformation in ONE pass.
 * No separate validation or transform layers needed.
 *
 * Usage:
 * ```typescript
 * import { importRedditExport, redditWorkspace } from './ingest/reddit';
 * import { createWorkspace } from 'epicenter/static';
 *
 * const client = createWorkspace(redditWorkspace);
 * const stats = await importRedditExport(zipFile, client);
 * console.log(`Imported ${stats.totalRows} rows`);
 * ```
 */

import { createWorkspace } from '../../static/index.js';
import { csvSchemas } from './csv-schemas.js';
import { parseRedditZip } from './parse.js';
import { type RedditWorkspace, redditWorkspace } from './workspace.js';

// Re-export workspace definition
export { redditWorkspace, type RedditWorkspace };

// Re-export types from csv-schemas
export type {
	AdsPreferenceRow,
	AnnouncementRow,
	ChatHistoryRow,
	CommentRow,
	CommentVoteRow,
	DraftRow,
	FriendRow,
	GildedContentRow,
	GoldReceivedRow,
	IpLogRow,
	LinkedIdentityRow,
	MessageRow,
	MultiredditRow,
	PayoutRow,
	PollVoteRow,
	PostRow,
	PostVoteRow,
	PurchaseRow,
	ScheduledPostRow,
	SubredditRow,
	SubscriptionRow,
} from './csv-schemas.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ImportStats = {
	tables: Record<string, number>;
	kv: number;
	totalRows: number;
};

export type ImportProgress = {
	phase: 'parse' | 'transform' | 'insert';
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

/** Convert camelCase to snake_case (e.g., 'postVotes' → 'post_votes') */
function camelToSnake(str: string): string {
	return str.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

const schemaEntries = Object.entries(csvSchemas);

// ═══════════════════════════════════════════════════════════════════════════════
// KV TRANSFORM
// ═══════════════════════════════════════════════════════════════════════════════

type KvData = {
	accountGender: string | null;
	birthdate: string | null;
	verifiedBirthdate: string | null;
	phoneNumber: string | null;
	stripeAccountId: string | null;
	personaInquiryId: string | null;
	twitterUsername: string | null;
	statistics: Record<string, string> | null;
	preferences: Record<string, string> | null;
};

function emptyToNull(value: string | undefined | null): string | null {
	if (value === undefined || value === null || value === '') return null;
	return value;
}

function parseDateToIso(dateStr: string | undefined | null): string | null {
	if (!dateStr || dateStr === '') return null;
	const d = new Date(dateStr);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function transformKv(raw: Record<string, Record<string, string>[]>): KvData {
	// Statistics → JSON object
	let statistics: Record<string, string> | null = null;
	if (raw.statistics && raw.statistics.length > 0) {
		statistics = {};
		for (const row of raw.statistics) {
			if (row.statistic && row.value) statistics[row.statistic] = row.value;
		}
	}

	// Preferences → JSON object
	let preferences: Record<string, string> | null = null;
	if (raw.user_preferences && raw.user_preferences.length > 0) {
		preferences = {};
		for (const row of raw.user_preferences) {
			if (row.preference && row.value) preferences[row.preference] = row.value;
		}
	}

	return {
		accountGender: emptyToNull(raw.account_gender?.[0]?.account_gender),
		birthdate: parseDateToIso(raw.birthdate?.[0]?.birthdate),
		verifiedBirthdate: parseDateToIso(raw.birthdate?.[0]?.verified_birthdate),
		phoneNumber: emptyToNull(raw.linked_phone_number?.[0]?.phone_number),
		stripeAccountId: emptyToNull(raw.stripe?.[0]?.stripe_account_id),
		personaInquiryId: emptyToNull(raw.persona?.[0]?.persona_inquiry_id),
		twitterUsername: emptyToNull(raw.twitter?.[0]?.username),
		statistics,
		preferences,
	};
}

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
	// PHASE 1: PARSE ZIP → RAW CSV DATA
	// ═══════════════════════════════════════════════════════════════════════════
	options?.onProgress?.({ phase: 'parse', current: 0, total: 1 });
	const rawData = await parseRedditZip(input);

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 2: TRANSFORM + INSERT (unified via csvSchemas)
	// ═══════════════════════════════════════════════════════════════════════════
	let tableIndex = 0;

	for (const [table, schema] of schemaEntries) {
		options?.onProgress?.({
			phase: 'transform',
			current: tableIndex++,
			total: schemaEntries.length,
			table,
		});

		const csv = camelToSnake(table);
		const csvData = rawData[csv] ?? [];
		if (csvData.length === 0) {
			stats.tables[table] = 0;
			continue;
		}

		// Parse all rows using the schema (validates + transforms in one pass)
		const rows = csvData.map((row) => (schema as any).assert(row));

		// Insert into table
		const tableClient = workspace.tables[
			table as keyof typeof workspace.tables
		] as unknown as {
			batch: (fn: (tx: { set: (row: { id: string }) => void }) => void) => void;
		};
		tableClient.batch((tx) => {
			for (const row of rows) tx.set(row);
		});

		stats.tables[table] = rows.length;
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 3: KV STORE
	// ═══════════════════════════════════════════════════════════════════════════
	options?.onProgress?.({ phase: 'insert', current: 0, total: 1 });
	const kvData = transformKv(rawData);
	workspace.kv.batch((tx) => {
		for (const [key, value] of Object.entries(kvData) as [
			keyof KvData,
			KvData[keyof KvData],
		][]) {
			if (value !== null) {
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

	// Compute table row counts
	const tables: Record<string, number> = {};
	for (const [table] of schemaEntries) {
		const csv = camelToSnake(table);
		const csvData = rawData[csv] ?? [];
		tables[table] = csvData.length;
	}

	// Check which KV fields have values
	const kvData = transformKv(rawData);
	const kv: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(kvData)) {
		kv[key] = value !== null;
	}

	const totalRows = Object.values(tables).reduce((a, b) => a + b, 0);

	return { tables, kv, totalRows };
}
