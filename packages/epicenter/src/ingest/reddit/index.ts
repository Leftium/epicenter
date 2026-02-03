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
	transformAdsPreferences,
	transformAnnouncements,
	transformAwards,
	transformChatHistory,
	transformCommerce,
	transformContent,
	transformIpLogs,
	transformKv,
	transformMessages,
	transformMultireddits,
	transformSaved,
	transformScheduledPosts,
	transformSocial,
	transformSubreddits,
	transformVotes,
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
	const totalTables = 14;
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
	// TABLE: content
	// ─────────────────────────────────────────────────────────────────────────────
	reportProgress('content');
	const contentRows = transformContent(data);
	workspace.tables.content.batch((tx) => {
		for (const row of contentRows) {
			tx.set(row);
		}
	});
	stats.tables.content = contentRows.length;

	// ─────────────────────────────────────────────────────────────────────────────
	// TABLE: votes
	// ─────────────────────────────────────────────────────────────────────────────
	reportProgress('votes');
	const voteRows = transformVotes(data);
	workspace.tables.votes.batch((tx) => {
		for (const row of voteRows) {
			tx.set(row);
		}
	});
	stats.tables.votes = voteRows.length;

	// ─────────────────────────────────────────────────────────────────────────────
	// TABLE: saved
	// ─────────────────────────────────────────────────────────────────────────────
	reportProgress('saved');
	const savedRows = transformSaved(data);
	workspace.tables.saved.batch((tx) => {
		for (const row of savedRows) {
			tx.set(row);
		}
	});
	stats.tables.saved = savedRows.length;

	// ─────────────────────────────────────────────────────────────────────────────
	// TABLE: messages
	// ─────────────────────────────────────────────────────────────────────────────
	reportProgress('messages');
	const messageRows = transformMessages(data);
	workspace.tables.messages.batch((tx) => {
		for (const row of messageRows) {
			tx.set(row);
		}
	});
	stats.tables.messages = messageRows.length;

	// ─────────────────────────────────────────────────────────────────────────────
	// TABLE: chatHistory
	// ─────────────────────────────────────────────────────────────────────────────
	reportProgress('chatHistory');
	const chatRows = transformChatHistory(data);
	workspace.tables.chatHistory.batch((tx) => {
		for (const row of chatRows) {
			tx.set(row);
		}
	});
	stats.tables.chatHistory = chatRows.length;

	// ─────────────────────────────────────────────────────────────────────────────
	// TABLE: subreddits
	// ─────────────────────────────────────────────────────────────────────────────
	reportProgress('subreddits');
	const subredditRows = transformSubreddits(data);
	workspace.tables.subreddits.batch((tx) => {
		for (const row of subredditRows) {
			tx.set(row);
		}
	});
	stats.tables.subreddits = subredditRows.length;

	// ─────────────────────────────────────────────────────────────────────────────
	// TABLE: multireddits
	// ─────────────────────────────────────────────────────────────────────────────
	reportProgress('multireddits');
	const multiredditRows = transformMultireddits(data);
	workspace.tables.multireddits.batch((tx) => {
		for (const row of multiredditRows) {
			tx.set(row);
		}
	});
	stats.tables.multireddits = multiredditRows.length;

	// ─────────────────────────────────────────────────────────────────────────────
	// TABLE: awards
	// ─────────────────────────────────────────────────────────────────────────────
	reportProgress('awards');
	const awardRows = transformAwards(data);
	workspace.tables.awards.batch((tx) => {
		for (const row of awardRows) {
			tx.set(row);
		}
	});
	stats.tables.awards = awardRows.length;

	// ─────────────────────────────────────────────────────────────────────────────
	// TABLE: commerce
	// ─────────────────────────────────────────────────────────────────────────────
	reportProgress('commerce');
	const commerceRows = transformCommerce(data);
	workspace.tables.commerce.batch((tx) => {
		for (const row of commerceRows) {
			tx.set(row);
		}
	});
	stats.tables.commerce = commerceRows.length;

	// ─────────────────────────────────────────────────────────────────────────────
	// TABLE: social
	// ─────────────────────────────────────────────────────────────────────────────
	reportProgress('social');
	const socialRows = transformSocial(data);
	workspace.tables.social.batch((tx) => {
		for (const row of socialRows) {
			tx.set(row);
		}
	});
	stats.tables.social = socialRows.length;

	// ─────────────────────────────────────────────────────────────────────────────
	// TABLE: announcements
	// ─────────────────────────────────────────────────────────────────────────────
	reportProgress('announcements');
	const announcementRows = transformAnnouncements(data);
	workspace.tables.announcements.batch((tx) => {
		for (const row of announcementRows) {
			tx.set(row);
		}
	});
	stats.tables.announcements = announcementRows.length;

	// ─────────────────────────────────────────────────────────────────────────────
	// TABLE: scheduledPosts
	// ─────────────────────────────────────────────────────────────────────────────
	reportProgress('scheduledPosts');
	const scheduledPostRows = transformScheduledPosts(data);
	workspace.tables.scheduledPosts.batch((tx) => {
		for (const row of scheduledPostRows) {
			tx.set(row);
		}
	});
	stats.tables.scheduledPosts = scheduledPostRows.length;

	// ─────────────────────────────────────────────────────────────────────────────
	// TABLE: ipLogs
	// ─────────────────────────────────────────────────────────────────────────────
	reportProgress('ipLogs');
	const ipLogRows = transformIpLogs(data);
	workspace.tables.ipLogs.batch((tx) => {
		for (const row of ipLogRows) {
			tx.set(row);
		}
	});
	stats.tables.ipLogs = ipLogRows.length;

	// ─────────────────────────────────────────────────────────────────────────────
	// TABLE: adsPreferences
	// ─────────────────────────────────────────────────────────────────────────────
	reportProgress('adsPreferences');
	const adsPreferenceRows = transformAdsPreferences(data);
	workspace.tables.adsPreferences.batch((tx) => {
		for (const row of adsPreferenceRows) {
			tx.set(row);
		}
	});
	stats.tables.adsPreferences = adsPreferenceRows.length;

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

// Transform configurations for data-driven imports
const tableTransforms = [
	{ name: 'content', transform: transformContent },
	{ name: 'votes', transform: transformVotes },
	{ name: 'saved', transform: transformSaved },
	{ name: 'messages', transform: transformMessages },
	{ name: 'chatHistory', transform: transformChatHistory },
	{ name: 'subreddits', transform: transformSubreddits },
	{ name: 'multireddits', transform: transformMultireddits },
	{ name: 'awards', transform: transformAwards },
	{ name: 'commerce', transform: transformCommerce },
	{ name: 'social', transform: transformSocial },
	{ name: 'announcements', transform: transformAnnouncements },
	{ name: 'scheduledPosts', transform: transformScheduledPosts },
	{ name: 'ipLogs', transform: transformIpLogs },
	{ name: 'adsPreferences', transform: transformAdsPreferences },
] as const;

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
