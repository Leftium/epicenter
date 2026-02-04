/**
 * Reddit Transform Functions
 *
 * Phase 3 of the import pipeline: Transform validated CSV data → table rows.
 *
 * Design: ArkType schemas handle both validation AND transformation in one pass.
 * Types are inferred from schemas - no explicit TypeScript type definitions needed.
 *
 * Transformations applied by schemas:
 * - Date strings → ISO strings (or null for invalid/empty)
 * - Empty strings → null for nullable fields (IPs, etc.)
 * - Numeric strings → numbers
 *
 * This file adds computed IDs where CSV rows lack them.
 */

import { emptyToNullFn, parseDateToIsoFn } from './morphs.js';
import { rowSchemas } from './schema.js';
import type { ValidatedRedditExport } from './validation.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE EXPORTS (inferred from schemas)
// ═══════════════════════════════════════════════════════════════════════════════

// Re-export inferred types for consumers who need them
export type PostsRow = typeof rowSchemas.post.infer;
export type CommentsRow = typeof rowSchemas.comment.infer;
export type DraftsRow = typeof rowSchemas.draft.infer & { id: string };
export type PostVotesRow = typeof rowSchemas.postVote.infer;
export type CommentVotesRow = typeof rowSchemas.commentVote.infer;
export type PollVotesRow = typeof rowSchemas.pollVoteCsv.infer & { id: string };
export type SavedPostsRow = typeof rowSchemas.permalink.infer;
export type SavedCommentsRow = typeof rowSchemas.permalink.infer;
export type HiddenPostsRow = typeof rowSchemas.permalink.infer;
export type MessagesRow = typeof rowSchemas.message.infer;
export type MessagesArchiveRow = typeof rowSchemas.message.infer;
export type ChatHistoryRow = { id: string } & Omit<
	typeof rowSchemas.chatHistory.infer,
	'message_id'
>;
export type SubredditRow = { id: string; subreddit: string };
export type MultiredditRow = typeof rowSchemas.multireddit.infer;
export type GildedContentRow = typeof rowSchemas.gildedContentCsv.infer & {
	id: string;
};
export type GoldReceivedRow = typeof rowSchemas.goldReceivedCsv.infer & {
	id: string;
};
export type PurchasesRow = typeof rowSchemas.purchaseCsv.infer & { id: string };
export type SubscriptionsRow = typeof rowSchemas.subscriptionCsv.infer & {
	id: string;
};
export type PayoutsRow = { id: string; date: string | null } & Omit<
	typeof rowSchemas.payoutCsv.infer,
	'date'
>;
export type FriendsRow = typeof rowSchemas.friendCsv.infer & { id: string };
export type LinkedIdentityRow = typeof rowSchemas.linkedIdentityCsv.infer & {
	id: string;
};
export type AnnouncementRow = typeof rowSchemas.announcement.infer & {
	id: string;
};
export type ScheduledPostRow = typeof rowSchemas.scheduledPostCsv.infer & {
	id: string;
};
export type IpLogRow = typeof rowSchemas.ipLog.infer & { id: string };
export type AdsPreferenceRow = typeof rowSchemas.adsPreference.infer & {
	id: string;
};

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSFORMS (1 CSV → 1 table)
// ═══════════════════════════════════════════════════════════════════════════════

export function transformPosts(data: ValidatedRedditExport): PostsRow[] {
	return data.posts.map((row) => rowSchemas.post.assert(row));
}

export function transformComments(data: ValidatedRedditExport): CommentsRow[] {
	return data.comments.map((row) => rowSchemas.comment.assert(row));
}

export function transformDrafts(data: ValidatedRedditExport): DraftsRow[] {
	return data.drafts.map((row) => ({
		...rowSchemas.draft.assert(row),
	}));
}

export function transformPostVotes(
	data: ValidatedRedditExport,
): PostVotesRow[] {
	return data.post_votes.map((row) => rowSchemas.postVote.assert(row));
}

export function transformCommentVotes(
	data: ValidatedRedditExport,
): CommentVotesRow[] {
	return data.comment_votes.map((row) => rowSchemas.commentVote.assert(row));
}

export function transformPollVotes(
	data: ValidatedRedditExport,
): PollVotesRow[] {
	return data.poll_votes.map((row) => {
		const parsed = rowSchemas.pollVoteCsv.assert(row);
		// Compute deterministic ID from fields
		const id = [
			parsed.post_id,
			parsed.user_selection ?? '',
			parsed.text ?? '',
			parsed.image_url ?? '',
			parsed.is_prediction ?? '',
			parsed.stake_amount ?? '',
		].join(':');
		return { id, ...parsed };
	});
}

export function transformSavedPosts(
	data: ValidatedRedditExport,
): SavedPostsRow[] {
	return data.saved_posts.map((row) => rowSchemas.permalink.assert(row));
}

export function transformSavedComments(
	data: ValidatedRedditExport,
): SavedCommentsRow[] {
	return data.saved_comments.map((row) => rowSchemas.permalink.assert(row));
}

export function transformHiddenPosts(
	data: ValidatedRedditExport,
): HiddenPostsRow[] {
	return data.hidden_posts.map((row) => rowSchemas.permalink.assert(row));
}

export function transformMessages(data: ValidatedRedditExport): MessagesRow[] {
	return (data.messages ?? []).map((row) => rowSchemas.message.assert(row));
}

export function transformMessagesArchive(
	data: ValidatedRedditExport,
): MessagesArchiveRow[] {
	return data.messages_archive.map((row) => rowSchemas.message.assert(row));
}

export function transformChatHistory(
	data: ValidatedRedditExport,
): ChatHistoryRow[] {
	return data.chat_history.map((row) => {
		const parsed = rowSchemas.chatHistory.assert(row);
		// Rename message_id to id
		const { message_id, ...rest } = parsed;
		return { id: message_id, ...rest };
	});
}

export function transformSubscribedSubreddits(
	data: ValidatedRedditExport,
): SubredditRow[] {
	return data.subscribed_subreddits.map((row) => ({
		id: row.subreddit,
		subreddit: row.subreddit,
	}));
}

export function transformModeratedSubreddits(
	data: ValidatedRedditExport,
): SubredditRow[] {
	return data.moderated_subreddits.map((row) => ({
		id: row.subreddit,
		subreddit: row.subreddit,
	}));
}

export function transformApprovedSubmitterSubreddits(
	data: ValidatedRedditExport,
): SubredditRow[] {
	return data.approved_submitter_subreddits.map((row) => ({
		id: row.subreddit,
		subreddit: row.subreddit,
	}));
}

export function transformMultireddits(
	data: ValidatedRedditExport,
): MultiredditRow[] {
	return data.multireddits.map((row) => rowSchemas.multireddit.assert(row));
}

export function transformGildedContent(
	data: ValidatedRedditExport,
): GildedContentRow[] {
	return data.gilded_content.map((row) => {
		const parsed = rowSchemas.gildedContentCsv.assert(row);
		// Compute deterministic ID
		const id = [
			parsed.content_link,
			parsed.date ?? '',
			parsed.award ?? '',
			parsed.amount ?? '',
		].join(':');
		return { id, ...parsed };
	});
}

export function transformGoldReceived(
	data: ValidatedRedditExport,
): GoldReceivedRow[] {
	return data.gold_received.map((row) => {
		const parsed = rowSchemas.goldReceivedCsv.assert(row);
		// Compute deterministic ID
		const id = [
			parsed.content_link,
			parsed.date ?? '',
			parsed.gold_received ?? '',
			parsed.gilder_username ?? '',
		].join(':');
		return { id, ...parsed };
	});
}

export function transformPurchases(
	data: ValidatedRedditExport,
): PurchasesRow[] {
	return data.purchases.map((row) => {
		const parsed = rowSchemas.purchaseCsv.assert(row);
		return { id: parsed.transaction_id, ...parsed };
	});
}

export function transformSubscriptions(
	data: ValidatedRedditExport,
): SubscriptionsRow[] {
	return data.subscriptions.map((row) => {
		const parsed = rowSchemas.subscriptionCsv.assert(row);
		return { id: parsed.subscription_id, ...parsed };
	});
}

export function transformPayouts(data: ValidatedRedditExport): PayoutsRow[] {
	return data.payouts.map((row) => {
		const parsed = rowSchemas.payoutCsv.assert(row);
		const dateIso = parseDateToIsoFn(parsed.date);
		const id = parsed.payout_id ?? dateIso ?? parsed.date;
		return {
			id,
			date: dateIso,
			payout_id: parsed.payout_id,
			payout_amount_usd: parsed.payout_amount_usd,
		};
	});
}

export function transformFriends(data: ValidatedRedditExport): FriendsRow[] {
	return data.friends.map((row) => {
		const parsed = rowSchemas.friendCsv.assert(row);
		return { id: parsed.username, ...parsed };
	});
}

export function transformLinkedIdentities(
	data: ValidatedRedditExport,
): LinkedIdentityRow[] {
	return data.linked_identities.map((row) => {
		const parsed = rowSchemas.linkedIdentityCsv.assert(row);
		return { id: `${parsed.issuer_id}:${parsed.subject_id}`, ...parsed };
	});
}

export function transformAnnouncements(
	data: ValidatedRedditExport,
): AnnouncementRow[] {
	return data.announcements.map((row) => {
		const parsed = rowSchemas.announcement.assert(row);
		return { id: parsed.announcement_id, ...parsed };
	});
}

export function transformScheduledPosts(
	data: ValidatedRedditExport,
): ScheduledPostRow[] {
	return data.scheduled_posts.map((row) => {
		const parsed = rowSchemas.scheduledPostCsv.assert(row);
		return { id: parsed.scheduled_post_id, ...parsed };
	});
}

export function transformIpLogs(data: ValidatedRedditExport): IpLogRow[] {
	return data.ip_logs.map((row) => {
		const parsed = rowSchemas.ipLog.assert(row);
		return { id: `${parsed.date}:${parsed.ip}`, ...parsed };
	});
}

export function transformSensitiveAdsPreferences(
	data: ValidatedRedditExport,
): AdsPreferenceRow[] {
	return data.sensitive_ads_preferences.map((row) => {
		const parsed = rowSchemas.adsPreference.assert(row);
		return { id: parsed.type, ...parsed };
	});
}

export const tableTransforms = [
	{ name: 'posts', transform: transformPosts },
	{ name: 'comments', transform: transformComments },
	{ name: 'drafts', transform: transformDrafts },
	{ name: 'post_votes', transform: transformPostVotes },
	{ name: 'comment_votes', transform: transformCommentVotes },
	{ name: 'poll_votes', transform: transformPollVotes },
	{ name: 'saved_posts', transform: transformSavedPosts },
	{ name: 'saved_comments', transform: transformSavedComments },
	{ name: 'hidden_posts', transform: transformHiddenPosts },
	{ name: 'messages', transform: transformMessages },
	{ name: 'messages_archive', transform: transformMessagesArchive },
	{ name: 'chat_history', transform: transformChatHistory },
	{ name: 'subscribed_subreddits', transform: transformSubscribedSubreddits },
	{ name: 'moderated_subreddits', transform: transformModeratedSubreddits },
	{
		name: 'approved_submitter_subreddits',
		transform: transformApprovedSubmitterSubreddits,
	},
	{ name: 'multireddits', transform: transformMultireddits },
	{ name: 'gilded_content', transform: transformGildedContent },
	{ name: 'gold_received', transform: transformGoldReceived },
	{ name: 'purchases', transform: transformPurchases },
	{ name: 'subscriptions', transform: transformSubscriptions },
	{ name: 'payouts', transform: transformPayouts },
	{ name: 'friends', transform: transformFriends },
	{ name: 'linked_identities', transform: transformLinkedIdentities },
	{ name: 'announcements', transform: transformAnnouncements },
	{ name: 'scheduled_posts', transform: transformScheduledPosts },
	{ name: 'ip_logs', transform: transformIpLogs },
	{
		name: 'sensitive_ads_preferences',
		transform: transformSensitiveAdsPreferences,
	},
] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// KV TRANSFORMS
// ═══════════════════════════════════════════════════════════════════════════════

export type KvData = {
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

export function transformKv(data: ValidatedRedditExport): KvData {
	// Statistics → JSON object
	let statistics: Record<string, string> | null = null;
	if (data.statistics.length > 0) {
		statistics = {};
		for (const row of data.statistics) {
			if (row.statistic && row.value) statistics[row.statistic] = row.value;
		}
	}

	// Preferences → JSON object
	let preferences: Record<string, string> | null = null;
	if (data.user_preferences.length > 0) {
		preferences = {};
		for (const row of data.user_preferences) {
			if (row.preference && row.value) preferences[row.preference] = row.value;
		}
	}

	return {
		accountGender: emptyToNullFn(data.account_gender[0]?.account_gender),
		birthdate: parseDateToIsoFn(data.birthdate[0]?.birthdate),
		verifiedBirthdate: parseDateToIsoFn(data.birthdate[0]?.verified_birthdate),
		phoneNumber: emptyToNullFn(data.linked_phone_number[0]?.phone_number),
		stripeAccountId: emptyToNullFn(data.stripe[0]?.stripe_account_id),
		personaInquiryId: emptyToNullFn(data.persona[0]?.persona_inquiry_id),
		twitterUsername: emptyToNullFn(data.twitter[0]?.username),
		statistics,
		preferences,
	};
}
