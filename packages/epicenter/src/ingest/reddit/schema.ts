/**
 * Reddit CSV Schema Definitions
 *
 * Unified ArkType schemas that handle both validation AND transformation in one pass.
 * Each schema defines:
 * - Input shape: What the raw CSV data looks like (strings from CSV parser)
 * - Output shape: What the transformed data looks like (parsed dates, nulls, etc.)
 *
 * Types are inferred from schemas - no explicit TypeScript type definitions needed.
 *
 * Usage:
 * ```typescript
 * // Parse and transform a CSV row in one call
 * const row = schemas.posts.item(rawCsvRow);
 *
 * // Type inference works automatically
 * type PostRow = typeof schemas.posts.item.infer;
 * ```
 */

import { scope } from 'arktype';
import {
	emptyToNull,
	dateToIso,
	optionalDateToIso,
	numericParse,
	voteDirection,
} from './morphs.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMA SCOPE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Define all schemas in a scope for better organization and cross-references.
 */
const $ = scope({
	// ─────────────────────────────────────────────────────────────────────────────
	// CORE CONTENT
	// ─────────────────────────────────────────────────────────────────────────────

	/** posts.csv row - transforms dates and handles empty IPs */
	postRow: {
		id: 'string',
		permalink: emptyToNull,
		date: dateToIso,
		ip: emptyToNull,
		subreddit: 'string',
		gildings: numericParse,
		'title?': 'string',
		'url?': 'string',
		'body?': 'string',
	},

	/** comments.csv row */
	commentRow: {
		id: 'string',
		permalink: emptyToNull,
		date: dateToIso,
		ip: emptyToNull,
		subreddit: 'string',
		gildings: numericParse,
		link: 'string',
		'parent?': 'string',
		'body?': 'string',
		'media?': 'string',
	},

	/** drafts.csv row */
	draftRow: {
		id: 'string',
		'title?': 'string',
		'body?': 'string',
		'kind?': 'string',
		created: optionalDateToIso,
		'spoiler?': 'string',
		'nsfw?': 'string',
		'original_content?': 'string',
		'content_category?': 'string',
		'flair_id?': 'string',
		'flair_text?': 'string',
		'send_replies?': 'string',
		'subreddit?': 'string',
		'is_public_link?': 'string',
	},

	// ─────────────────────────────────────────────────────────────────────────────
	// VOTES / SAVES / VISIBILITY
	// ─────────────────────────────────────────────────────────────────────────────

	/** post_votes.csv row */
	postVoteRow: {
		id: 'string',
		permalink: 'string',
		direction: voteDirection,
	},

	/** comment_votes.csv row */
	commentVoteRow: {
		id: 'string',
		permalink: 'string',
		direction: voteDirection,
	},

	/** poll_votes.csv row - needs computed ID */
	pollVoteCsvRow: {
		post_id: 'string',
		'user_selection?': 'string',
		'text?': 'string',
		'image_url?': 'string',
		'is_prediction?': 'string',
		'stake_amount?': 'string',
	},

	/** saved_posts.csv / saved_comments.csv / hidden_posts.csv row */
	permalinkRow: {
		id: 'string',
		permalink: 'string',
	},

	// ─────────────────────────────────────────────────────────────────────────────
	// MESSAGING
	// ─────────────────────────────────────────────────────────────────────────────

	/** messages.csv / messages_archive.csv row */
	messageRow: {
		id: 'string',
		permalink: 'string',
		thread_id: emptyToNull,
		date: optionalDateToIso,
		ip: emptyToNull,
		'from?': 'string',
		'to?': 'string',
		'subject?': 'string',
		'body?': 'string',
	},

	/** chat_history.csv row */
	chatHistoryRow: {
		message_id: 'string',
		created_at: optionalDateToIso,
		updated_at: optionalDateToIso,
		username: emptyToNull,
		message: emptyToNull,
		thread_parent_message_id: emptyToNull,
		channel_url: emptyToNull,
		subreddit: emptyToNull,
		channel_name: emptyToNull,
		conversation_type: emptyToNull,
	},

	// ─────────────────────────────────────────────────────────────────────────────
	// SUBREDDITS
	// ─────────────────────────────────────────────────────────────────────────────

	/** subscribed/moderated/approved_submitter subreddits row */
	subredditRow: {
		subreddit: 'string',
	},

	/** multireddits.csv row */
	multiredditRow: {
		id: 'string',
		'display_name?': 'string',
		date: optionalDateToIso,
		'description?': 'string',
		'privacy?': 'string',
		'subreddits?': 'string',
		'image_url?': 'string',
		'is_owner?': 'string',
		'favorited?': 'string',
		'followers?': 'string',
	},

	// ─────────────────────────────────────────────────────────────────────────────
	// AWARDS
	// ─────────────────────────────────────────────────────────────────────────────

	/** gilded_content.csv row - needs computed ID */
	gildedContentCsvRow: {
		content_link: 'string',
		'award?': 'string',
		'amount?': 'string',
		date: optionalDateToIso,
	},

	/** gold_received.csv row - needs computed ID */
	goldReceivedCsvRow: {
		content_link: 'string',
		'gold_received?': 'string',
		'gilder_username?': 'string',
		date: optionalDateToIso,
	},

	// ─────────────────────────────────────────────────────────────────────────────
	// COMMERCE
	// ─────────────────────────────────────────────────────────────────────────────

	/** purchases.csv row */
	purchaseCsvRow: {
		'processor?': 'string',
		transaction_id: 'string',
		'product?': 'string',
		date: optionalDateToIso,
		'cost?': 'string',
		'currency?': 'string',
		'status?': 'string',
	},

	/** subscriptions.csv row */
	subscriptionCsvRow: {
		'processor?': 'string',
		subscription_id: 'string',
		'product?': 'string',
		'product_id?': 'string',
		'product_name?': 'string',
		'status?': 'string',
		start_date: optionalDateToIso,
		end_date: optionalDateToIso,
	},

	/** payouts.csv row */
	payoutCsvRow: {
		'payout_amount_usd?': 'string',
		date: 'string', // Keep as string for ID computation
		'payout_id?': 'string',
	},

	// ─────────────────────────────────────────────────────────────────────────────
	// SOCIAL
	// ─────────────────────────────────────────────────────────────────────────────

	/** friends.csv row */
	friendCsvRow: {
		username: 'string',
		'note?': 'string',
	},

	/** linked_identities.csv row */
	linkedIdentityCsvRow: {
		issuer_id: 'string',
		subject_id: 'string',
	},

	// ─────────────────────────────────────────────────────────────────────────────
	// OTHER TABLES
	// ─────────────────────────────────────────────────────────────────────────────

	/** announcements.csv row */
	announcementRow: {
		announcement_id: 'string',
		sent_at: optionalDateToIso,
		read_at: optionalDateToIso,
		from_id: emptyToNull,
		from_username: emptyToNull,
		subject: emptyToNull,
		body: emptyToNull,
		url: emptyToNull,
	},

	/** scheduled_posts.csv row */
	scheduledPostCsvRow: {
		scheduled_post_id: 'string',
		'subreddit?': 'string',
		'title?': 'string',
		'body?': 'string',
		'url?': 'string',
		submission_time: optionalDateToIso,
		'recurrence?': 'string',
	},

	/** ip_logs.csv row */
	ipLogRow: {
		date: 'string',
		ip: 'string',
	},

	/** sensitive_ads_preferences.csv row */
	adsPreferenceRow: {
		type: 'string',
		'preference?': 'string',
	},

	// ─────────────────────────────────────────────────────────────────────────────
	// SINGLETON / KV DATA
	// ─────────────────────────────────────────────────────────────────────────────

	accountGenderRow: { 'account_gender?': 'string' },

	birthdateRow: {
		'birthdate?': 'string',
		'verified_birthdate?': 'string',
		'verification_state?': 'string',
		'verification_method?': 'string',
	},

	statisticRow: {
		statistic: 'string',
		'value?': 'string',
	},

	userPreferenceRow: {
		preference: 'string',
		'value?': 'string',
	},

	linkedPhoneRow: { phone_number: 'string' },
	stripeRow: { stripe_account_id: 'string' },
	twitterRow: { username: 'string' },
	personaRow: { persona_inquiry_id: 'string' },

	// ─────────────────────────────────────────────────────────────────────────────
	// HEADER FILES (redundant but validated)
	// ─────────────────────────────────────────────────────────────────────────────

	postHeaderRow: {
		id: 'string',
		permalink: 'string',
		date: 'string',
		ip: 'string',
		subreddit: 'string',
		gildings: 'string',
		'url?': 'string',
	},

	commentHeaderRow: {
		id: 'string',
		permalink: 'string',
		date: 'string',
		ip: 'string',
		subreddit: 'string',
		gildings: 'string',
		link: 'string',
		'parent?': 'string',
	},

	messageHeaderRow: {
		id: 'string',
		permalink: 'string',
		'thread_id?': 'string',
		'date?': 'string',
		ip: 'string',
		'from?': 'string',
		'to?': 'string',
	},

	checkfileRow: {
		filename: 'string',
		'sha256?': 'string',
	},
});

// Export the compiled scope
const types = $.export();

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTED SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Individual row schemas for transforming CSV rows.
 * Use `.assert()` or direct call to parse and transform a row.
 */
export const rowSchemas = {
	post: types.postRow,
	comment: types.commentRow,
	draft: types.draftRow,
	postVote: types.postVoteRow,
	commentVote: types.commentVoteRow,
	pollVoteCsv: types.pollVoteCsvRow,
	permalink: types.permalinkRow,
	message: types.messageRow,
	chatHistory: types.chatHistoryRow,
	subreddit: types.subredditRow,
	multireddit: types.multiredditRow,
	gildedContentCsv: types.gildedContentCsvRow,
	goldReceivedCsv: types.goldReceivedCsvRow,
	purchaseCsv: types.purchaseCsvRow,
	subscriptionCsv: types.subscriptionCsvRow,
	payoutCsv: types.payoutCsvRow,
	friendCsv: types.friendCsvRow,
	linkedIdentityCsv: types.linkedIdentityCsvRow,
	announcement: types.announcementRow,
	scheduledPostCsv: types.scheduledPostCsvRow,
	ipLog: types.ipLogRow,
	adsPreference: types.adsPreferenceRow,
	accountGender: types.accountGenderRow,
	birthdate: types.birthdateRow,
	statistic: types.statisticRow,
	userPreference: types.userPreferenceRow,
	linkedPhone: types.linkedPhoneRow,
	stripe: types.stripeRow,
	twitter: types.twitterRow,
	persona: types.personaRow,
	postHeader: types.postHeaderRow,
	commentHeader: types.commentHeaderRow,
	messageHeader: types.messageHeaderRow,
	checkfile: types.checkfileRow,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE EXPORTS (inferred from schemas)
// ═══════════════════════════════════════════════════════════════════════════════

// Row types (output of parsing)
export type PostRow = typeof rowSchemas.post.infer;
export type CommentRow = typeof rowSchemas.comment.infer;
export type DraftRow = typeof rowSchemas.draft.infer;
export type PostVoteRow = typeof rowSchemas.postVote.infer;
export type CommentVoteRow = typeof rowSchemas.commentVote.infer;
export type PollVoteCsvRow = typeof rowSchemas.pollVoteCsv.infer;
export type PermalinkRow = typeof rowSchemas.permalink.infer;
export type MessageRow = typeof rowSchemas.message.infer;
export type ChatHistoryRow = typeof rowSchemas.chatHistory.infer;
export type SubredditRow = typeof rowSchemas.subreddit.infer;
export type MultiredditRow = typeof rowSchemas.multireddit.infer;
export type GildedContentCsvRow = typeof rowSchemas.gildedContentCsv.infer;
export type GoldReceivedCsvRow = typeof rowSchemas.goldReceivedCsv.infer;
export type PurchaseCsvRow = typeof rowSchemas.purchaseCsv.infer;
export type SubscriptionCsvRow = typeof rowSchemas.subscriptionCsv.infer;
export type PayoutCsvRow = typeof rowSchemas.payoutCsv.infer;
export type FriendCsvRow = typeof rowSchemas.friendCsv.infer;
export type LinkedIdentityCsvRow = typeof rowSchemas.linkedIdentityCsv.infer;
export type AnnouncementRow = typeof rowSchemas.announcement.infer;
export type ScheduledPostCsvRow = typeof rowSchemas.scheduledPostCsv.infer;
export type IpLogRow = typeof rowSchemas.ipLog.infer;
export type AdsPreferenceRow = typeof rowSchemas.adsPreference.infer;

// CSV input types (for validation before morphs)
export type PostCsvInput = typeof rowSchemas.post.inferIn;
export type CommentCsvInput = typeof rowSchemas.comment.inferIn;
