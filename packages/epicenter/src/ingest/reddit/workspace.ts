/**
 * Reddit Workspace Definition
 *
 * Static API workspace with 14 tables + KV store for Reddit GDPR export data.
 * Uses arktype schemas for type validation and inference.
 */

import { type } from 'arktype';
import { defineTable, defineWorkspace, defineKv } from '../../static/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TABLE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Content: posts, comments, drafts
 * Source CSVs: posts.csv, comments.csv, drafts.csv
 */
const content = defineTable(
	type({
		id: 'string',
		type: "'post' | 'comment' | 'draft'",
		permalink: 'string | null',
		date: 'string | null',
		ip: 'string | null',
		subreddit: 'string | null',
		gildings: 'string | null',
		// Post-specific
		'title?': 'string',
		'url?': 'string',
		// Comment-specific
		'link?': 'string',
		'parent?': 'string',
		// Shared
		'body?': 'string',
		'media?': 'string',
		// Draft-specific
		'kind?': 'string',
		'spoiler?': 'string',
		'nsfw?': 'string',
	}),
);

/**
 * Votes: post_votes, comment_votes, poll_votes
 * Source CSVs: post_votes.csv, comment_votes.csv, poll_votes.csv
 */
const votes = defineTable(
	type({
		id: 'string', // Composite: `${targetType}:${targetId}`
		targetType: "'post' | 'comment' | 'poll'",
		targetId: 'string',
		permalink: 'string | null',
		direction: "'up' | 'down' | 'none' | 'removed' | null", // Validated enum
		// Poll-specific
		'userSelection?': 'string',
		'text?': 'string',
		'isPrediction?': 'string',
		'stakeAmount?': 'string',
	}),
);

/**
 * Saved: saved_posts, saved_comments, hidden_posts
 * Source CSVs: saved_posts.csv, saved_comments.csv, hidden_posts.csv
 */
const saved = defineTable(
	type({
		id: 'string', // Composite: `${action}:${targetType}:${targetId}`
		action: "'save' | 'hide'",
		targetType: "'post' | 'comment'",
		targetId: 'string',
		permalink: 'string',
	}),
);

/**
 * Messages: messages, messages_archive
 * Source CSVs: messages.csv, messages_archive.csv
 */
const messages = defineTable(
	type({
		id: 'string',
		archived: 'boolean',
		permalink: 'string | null',
		threadId: 'string | null',
		date: 'string | null',
		ip: 'string | null',
		'from?': 'string',
		'to?': 'string',
		'subject?': 'string',
		'body?': 'string',
	}),
);

/**
 * Chat History (unique structure)
 * Source CSV: chat_history.csv
 */
const chatHistory = defineTable(
	type({
		id: 'string', // message_id from CSV
		createdAt: 'string | null',
		updatedAt: 'string | null',
		username: 'string | null',
		message: 'string | null',
		threadParentMessageId: 'string | null',
		channelUrl: 'string | null',
		subreddit: 'string | null',
		channelName: 'string | null',
		conversationType: 'string | null',
	}),
);

/**
 * Subreddits: subscribed, moderated, approved_submitter
 * Source CSVs: subscribed_subreddits.csv, moderated_subreddits.csv, approved_submitter_subreddits.csv
 */
const subreddits = defineTable(
	type({
		id: 'string', // Composite: `${role}:${subreddit}`
		subreddit: 'string',
		role: "'subscribed' | 'moderated' | 'approved_submitter'",
	}),
);

/**
 * Multireddits (unique structure with subreddits array)
 * Source CSV: multireddits.csv
 */
const multireddits = defineTable(
	type({
		id: 'string',
		displayName: 'string | null',
		date: 'string | null',
		description: 'string | null',
		privacy: 'string | null',
		subreddits: 'string | null', // Comma-separated list
		imageUrl: 'string | null',
		isOwner: 'string | null',
		favorited: 'string | null',
		followers: 'string | null',
	}),
);

/**
 * Awards: gilded_content, gold_received
 * Source CSVs: gilded_content.csv, gold_received.csv
 */
const awards = defineTable(
	type({
		id: 'string', // Composite: `${direction}:${contentLink}`
		direction: "'given' | 'received'",
		contentLink: 'string',
		award: 'string | null',
		amount: 'string | null',
		date: 'string | null',
		'gilderUsername?': 'string', // Only for received
	}),
);

/**
 * Commerce: purchases, subscriptions, payouts
 * Source CSVs: purchases.csv, subscriptions.csv, payouts.csv
 */
const commerce = defineTable(
	type({
		id: 'string',
		type: "'purchase' | 'subscription' | 'payout'",
		date: 'string | null',
		// Purchase-specific
		'processor?': 'string',
		'transactionId?': 'string',
		'product?': 'string',
		'cost?': 'string',
		'currency?': 'string',
		'status?': 'string',
		// Subscription-specific
		'subscriptionId?': 'string',
		'productId?': 'string',
		'productName?': 'string',
		'startDate?': 'string',
		'endDate?': 'string',
		// Payout-specific
		'payoutId?': 'string',
		'payoutAmountUsd?': 'string',
	}),
);

/**
 * Social: friends, linked_identities
 * Source CSVs: friends.csv, linked_identities.csv
 */
const social = defineTable(
	type({
		id: 'string', // Composite: `${type}:${identifier}`
		type: "'friend' | 'linked_identity'",
		// Friend-specific
		'username?': 'string',
		'note?': 'string',
		// Linked identity-specific
		'issuerId?': 'string',
		'subjectId?': 'string',
	}),
);

/**
 * Announcements (unique structure)
 * Source CSV: announcements.csv
 */
const announcements = defineTable(
	type({
		id: 'string', // announcement_id from CSV
		sentAt: 'string | null',
		readAt: 'string | null',
		fromId: 'string | null',
		fromUsername: 'string | null',
		subject: 'string | null',
		body: 'string | null',
		url: 'string | null',
	}),
);

/**
 * Scheduled Posts (unique structure)
 * Source CSV: scheduled_posts.csv
 */
const scheduledPosts = defineTable(
	type({
		id: 'string', // scheduled_post_id from CSV
		subreddit: 'string | null',
		title: 'string | null',
		body: 'string | null',
		url: 'string | null',
		submissionTime: 'string | null',
		recurrence: 'string | null',
	}),
);

/**
 * IP Logs (unique structure)
 * Source CSV: ip_logs.csv
 */
const ipLogs = defineTable(
	type({
		id: 'string', // Generated hash of date:ip
		date: 'string',
		ip: 'string',
	}),
);

/**
 * Ads Preferences (unique structure)
 * Source CSV: sensitive_ads_preferences.csv
 */
const adsPreferences = defineTable(
	type({
		id: 'string', // type field as ID
		type: 'string',
		preference: 'string | null',
	}),
);

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

export const redditWorkspace = defineWorkspace({
	id: 'reddit',

	tables: {
		content,
		votes,
		saved,
		messages,
		chatHistory,
		subreddits,
		multireddits,
		awards,
		commerce,
		social,
		announcements,
		scheduledPosts,
		ipLogs,
		adsPreferences,
	},

	kv: {
		// Singleton values from CSV files
		accountGender: defineKv(type('string | null')),
		birthdate: defineKv(type('string | null')),
		verifiedBirthdate: defineKv(type('string | null')),
		phoneNumber: defineKv(type('string | null')),
		stripeAccountId: defineKv(type('string | null')),
		personaInquiryId: defineKv(type('string | null')),
		twitterUsername: defineKv(type('string | null')),
		// Key-value pairs stored as JSON
		statistics: defineKv(type('Record<string, string> | null')),
		preferences: defineKv(type('Record<string, string> | null')),
	},
});

export type RedditWorkspace = typeof redditWorkspace;
