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
	transformContent,
	transformVotes,
	transformSaved,
	transformMessages,
	transformChatHistory,
	transformSubreddits,
	transformMultireddits,
	transformAwards,
	transformCommerce,
	transformSocial,
	transformAnnouncements,
	transformScheduledPosts,
	transformIpLogs,
	transformAdsPreferences,
	transformKv,
} from './transform.js';
import { validateRedditExport } from './validation.js';
import { redditWorkspace, type RedditWorkspace } from './workspace.js';

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
		if (kvData.accountGender !== null) {
			tx.set('accountGender', kvData.accountGender);
			stats.kv++;
		}
		if (kvData.birthdate !== null) {
			tx.set('birthdate', kvData.birthdate);
			stats.kv++;
		}
		if (kvData.verifiedBirthdate !== null) {
			tx.set('verifiedBirthdate', kvData.verifiedBirthdate);
			stats.kv++;
		}
		if (kvData.phoneNumber !== null) {
			tx.set('phoneNumber', kvData.phoneNumber);
			stats.kv++;
		}
		if (kvData.stripeAccountId !== null) {
			tx.set('stripeAccountId', kvData.stripeAccountId);
			stats.kv++;
		}
		if (kvData.personaInquiryId !== null) {
			tx.set('personaInquiryId', kvData.personaInquiryId);
			stats.kv++;
		}
		if (kvData.twitterUsername !== null) {
			tx.set('twitterUsername', kvData.twitterUsername);
			stats.kv++;
		}
		if (kvData.statistics !== null) {
			tx.set('statistics', kvData.statistics);
			stats.kv++;
		}
		if (kvData.preferences !== null) {
			tx.set('preferences', kvData.preferences);
			stats.kv++;
		}
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// DONE
	// ═══════════════════════════════════════════════════════════════════════════
	stats.totalRows = Object.values(stats.tables).reduce((a, b) => a + b, 0) + stats.kv;

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

	const tables: Record<string, number> = {
		content: data.posts.length + data.comments.length + data.drafts.length,
		votes: data.post_votes.length + data.comment_votes.length + data.poll_votes.length,
		saved: data.saved_posts.length + data.saved_comments.length + data.hidden_posts.length,
		messages: (data.messages?.length ?? 0) + data.messages_archive.length,
		chatHistory: data.chat_history.length,
		subreddits:
			data.subscribed_subreddits.length +
			data.moderated_subreddits.length +
			data.approved_submitter_subreddits.length,
		multireddits: data.multireddits.length,
		awards: data.gilded_content.length + data.gold_received.length,
		commerce: data.purchases.length + data.subscriptions.length + data.payouts.length,
		social: data.friends.length + data.linked_identities.length,
		announcements: data.announcements.length,
		scheduledPosts: data.scheduled_posts.length,
		ipLogs: data.ip_logs.length,
		adsPreferences: data.sensitive_ads_preferences.length,
	};

	const kv: Record<string, boolean> = {
		accountGender: !!data.account_gender[0]?.account_gender,
		birthdate: !!data.birthdate[0]?.birthdate,
		verifiedBirthdate: !!data.birthdate[0]?.verified_birthdate,
		phoneNumber: !!data.linked_phone_number[0]?.phone_number,
		stripeAccountId: !!data.stripe[0]?.stripe_account_id,
		personaInquiryId: !!data.persona[0]?.persona_inquiry_id,
		twitterUsername: !!data.twitter[0]?.username,
		statistics: data.statistics.length > 0,
		preferences: data.user_preferences.length > 0,
	};

	const totalRows = Object.values(tables).reduce((a, b) => a + b, 0);

	return { tables, kv, totalRows };
}
