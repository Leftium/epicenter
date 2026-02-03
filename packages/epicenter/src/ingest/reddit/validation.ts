/**
 * Reddit CSV Validation Schema
 *
 * Validates raw CSV data BEFORE transformation.
 * Uses arktype to:
 * - Enforce required fields exist
 * - Parse dates from strings
 * - Parse numeric strings to numbers
 * - Validate enums (vote direction)
 *
 * Note: IP fields are often empty strings in real exports, so we use 'string' not 'string.ip'
 */

import { type } from 'arktype';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Parse date string - validates format but keeps as string for transform phase */
const date = type('string.date.parse');

/** Vote direction enum */
const voteDirection = type("'up' | 'down' | 'none' | 'removed'");

// ═══════════════════════════════════════════════════════════════════════════════
// CSV VALIDATION SCHEMA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validates raw Reddit GDPR CSV data.
 *
 * This schema is applied to the parsed CSV output BEFORE transformation.
 * It ensures the data matches Reddit's expected format.
 */
export const csvValidationSchema = type({
	// ─────────────────────────────────────────────────────────────────────────────
	// CORE CONTENT
	// ─────────────────────────────────────────────────────────────────────────────
	posts: type({
		id: 'string',
		permalink: 'string',
		date: date,
		ip: 'string', // Often empty string
		subreddit: 'string',
		gildings: 'string.numeric.parse',
		'title?': 'string',
		'url?': 'string',
		'body?': 'string',
	}).array(),

	comments: type({
		id: 'string',
		permalink: 'string',
		date: date,
		ip: 'string', // Often empty string
		subreddit: 'string',
		gildings: 'string.numeric.parse',
		link: 'string',
		'parent?': 'string',
		'body?': 'string',
		'media?': 'string',
	}).array(),

	drafts: type({
		id: 'string',
		'title?': 'string',
		'body?': 'string',
		'kind?': 'string',
		'created?': 'string',
		'spoiler?': 'string',
		'nsfw?': 'string',
		'original_content?': 'string',
		'content_category?': 'string',
		'flair_id?': 'string',
		'flair_text?': 'string',
		'send_replies?': 'string',
		'subreddit?': 'string',
		'is_public_link?': 'string',
	}).array(),

	// ─────────────────────────────────────────────────────────────────────────────
	// VOTES / SAVES / VISIBILITY
	// ─────────────────────────────────────────────────────────────────────────────
	post_votes: type({
		id: 'string',
		permalink: 'string',
		direction: voteDirection,
	}).array(),

	comment_votes: type({
		id: 'string',
		permalink: 'string',
		direction: voteDirection,
	}).array(),

	poll_votes: type({
		post_id: 'string',
		'user_selection?': 'string',
		'text?': 'string',
		'image_url?': 'string',
		'is_prediction?': 'string',
		'stake_amount?': 'string',
	}).array(),

	saved_posts: type({ id: 'string', permalink: 'string' }).array(),
	saved_comments: type({ id: 'string', permalink: 'string' }).array(),
	hidden_posts: type({ id: 'string', permalink: 'string' }).array(),

	// ─────────────────────────────────────────────────────────────────────────────
	// MESSAGING
	// Note: messages.csv may be absent if user has no active messages
	// ─────────────────────────────────────────────────────────────────────────────
	'messages?': type({
		id: 'string',
		permalink: 'string',
		'thread_id?': 'string',
		'date?': 'string',
		ip: 'string', // Often empty
		'from?': 'string',
		'to?': 'string',
		'subject?': 'string',
		'body?': 'string',
	}).array(),

	messages_archive: type({
		id: 'string',
		permalink: 'string',
		'thread_id?': 'string',
		'date?': 'string',
		ip: 'string', // Often empty
		'from?': 'string',
		'to?': 'string',
		'subject?': 'string',
		'body?': 'string',
	}).array(),

	chat_history: type({
		message_id: 'string',
		'created_at?': 'string',
		'updated_at?': 'string',
		'username?': 'string',
		'message?': 'string',
		'thread_parent_message_id?': 'string',
		'channel_url?': 'string',
		'subreddit?': 'string',
		'channel_name?': 'string',
		'conversation_type?': 'string',
	}).array(),

	// ─────────────────────────────────────────────────────────────────────────────
	// SUBREDDITS
	// ─────────────────────────────────────────────────────────────────────────────
	subscribed_subreddits: type({ subreddit: 'string' }).array(),
	moderated_subreddits: type({ subreddit: 'string' }).array(),
	approved_submitter_subreddits: type({ subreddit: 'string' }).array(),

	multireddits: type({
		id: 'string',
		'display_name?': 'string',
		'date?': 'string',
		'description?': 'string',
		'privacy?': 'string',
		'subreddits?': 'string',
		'image_url?': 'string',
		'is_owner?': 'string',
		'favorited?': 'string',
		'followers?': 'string',
	}).array(),

	// ─────────────────────────────────────────────────────────────────────────────
	// AWARDS
	// ─────────────────────────────────────────────────────────────────────────────
	gilded_content: type({
		content_link: 'string',
		'award?': 'string',
		'amount?': 'string',
		'date?': 'string',
	}).array(),

	gold_received: type({
		content_link: 'string',
		'gold_received?': 'string',
		'gilder_username?': 'string',
		'date?': 'string',
	}).array(),

	// ─────────────────────────────────────────────────────────────────────────────
	// COMMERCE
	// ─────────────────────────────────────────────────────────────────────────────
	purchases: type({
		'processor?': 'string',
		transaction_id: 'string',
		'product?': 'string',
		'date?': 'string',
		'cost?': 'string',
		'currency?': 'string',
		'status?': 'string',
	}).array(),

	subscriptions: type({
		'processor?': 'string',
		subscription_id: 'string',
		'product?': 'string',
		'product_id?': 'string',
		'product_name?': 'string',
		'status?': 'string',
		'start_date?': 'string',
		'end_date?': 'string',
	}).array(),

	payouts: type({
		'payout_amount_usd?': 'string',
		date: 'string',
		'payout_id?': 'string',
	}).array(),

	// ─────────────────────────────────────────────────────────────────────────────
	// SOCIAL
	// ─────────────────────────────────────────────────────────────────────────────
	friends: type({
		username: 'string',
		'note?': 'string',
	}).array(),

	linked_identities: type({
		issuer_id: 'string',
		subject_id: 'string',
	}).array(),

	// ─────────────────────────────────────────────────────────────────────────────
	// OTHER TABLES
	// ─────────────────────────────────────────────────────────────────────────────
	announcements: type({
		announcement_id: 'string',
		'sent_at?': 'string',
		'read_at?': 'string',
		'from_id?': 'string',
		'from_username?': 'string',
		'subject?': 'string',
		'body?': 'string',
		'url?': 'string',
	}).array(),

	scheduled_posts: type({
		scheduled_post_id: 'string',
		'subreddit?': 'string',
		'title?': 'string',
		'body?': 'string',
		'url?': 'string',
		'submission_time?': 'string',
		'recurrence?': 'string',
	}).array(),

	ip_logs: type({
		date: 'string', // Can be 'registration ip' literal
		ip: 'string',
	}).array(),

	sensitive_ads_preferences: type({
		type: 'string',
		'preference?': 'string',
	}).array(),

	// ─────────────────────────────────────────────────────────────────────────────
	// SINGLETON / KV DATA
	// ─────────────────────────────────────────────────────────────────────────────
	account_gender: type({ 'account_gender?': 'string' }).array(),

	birthdate: type({
		'birthdate?': 'string',
		'verified_birthdate?': 'string',
		'verification_state?': 'string',
		'verification_method?': 'string',
	}).array(),

	statistics: type({
		statistic: 'string',
		'value?': 'string',
	}).array(),

	user_preferences: type({
		preference: 'string',
		'value?': 'string',
	}).array(),

	linked_phone_number: type({ phone_number: 'string' }).array(),
	stripe: type({ stripe_account_id: 'string' }).array(),
	twitter: type({ username: 'string' }).array(),
	persona: type({ persona_inquiry_id: 'string' }).array(),

	// ─────────────────────────────────────────────────────────────────────────────
	// REDUNDANT (validated but skipped during transform)
	// ─────────────────────────────────────────────────────────────────────────────
	post_headers: type({
		id: 'string',
		permalink: 'string',
		date: 'string',
		ip: 'string',
		subreddit: 'string',
		gildings: 'string',
		'url?': 'string',
	}).array(),

	comment_headers: type({
		id: 'string',
		permalink: 'string',
		date: 'string',
		ip: 'string',
		subreddit: 'string',
		gildings: 'string',
		link: 'string',
		'parent?': 'string',
	}).array(),

	// Note: message_headers.csv may be absent if messages.csv is absent
	'message_headers?': type({
		id: 'string',
		permalink: 'string',
		'thread_id?': 'string',
		'date?': 'string',
		ip: 'string',
		'from?': 'string',
		'to?': 'string',
	}).array(),

	messages_archive_headers: type({
		id: 'string',
		permalink: 'string',
		'thread_id?': 'string',
		'date?': 'string',
		ip: 'string',
		'from?': 'string',
		'to?': 'string',
	}).array(),

	// ─────────────────────────────────────────────────────────────────────────────
	// METADATA (skipped)
	// ─────────────────────────────────────────────────────────────────────────────
	checkfile: type({
		filename: 'string',
		'sha256?': 'string',
	}).array(),
});

/** Validated Reddit export data type (inferred from schema) */
export type ValidatedRedditExport = typeof csvValidationSchema.infer;

/**
 * Validate raw parsed CSV data.
 * Throws ArkType validation error if data doesn't match expected schema.
 */
export function validateRedditExport(
	rawData: Record<string, Record<string, string>[]>,
): ValidatedRedditExport {
	return csvValidationSchema.assert(rawData);
}
