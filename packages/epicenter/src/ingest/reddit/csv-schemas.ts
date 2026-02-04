/**
 * Reddit CSV Schemas
 *
 * UNIFIED schemas that do EVERYTHING in one pass:
 * 1. Validate CSV structure
 * 2. Parse values (dates → ISO, numbers, empty → null)
 * 3. Compute IDs where needed
 * 4. Output table-ready rows
 *
 * Types are inferred from schemas. No separate type definitions needed.
 *
 * Usage:
 * ```typescript
 * const rows = csvData.posts.map(csvSchemas.posts.assert);
 * // rows is already typed and ready for table insertion
 * ```
 */

import { type } from 'arktype';

// ═══════════════════════════════════════════════════════════════════════════════
// MORPHS (inline for clarity)
// ═══════════════════════════════════════════════════════════════════════════════

const REGISTRATION_IP = 'registration ip';

/** Empty string → null */
const emptyToNull = type('string').pipe(
	(s): string | null => (s === '' ? null : s),
);

/** Optional string → null */
const optionalToNull = type('string | undefined').pipe(
	(s): string | null => (!s || s === '' ? null : s),
);

/** Date string → ISO string | null */
const dateToIso = type('string').pipe((s): string | null => {
	if (!s || s === '' || s === REGISTRATION_IP) return null;
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
});

/** Optional date → ISO string | null */
const optionalDateToIso = type('string | undefined').pipe((s): string | null => {
	if (!s || s === '' || s === REGISTRATION_IP) return null;
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
});

/** Numeric string → number */
const numericParse = type('string.numeric.parse');

/** Vote direction */
const voteDirection = type("'up' | 'down' | 'none' | 'removed'");

// ═══════════════════════════════════════════════════════════════════════════════
// TABLE SCHEMAS (CSV → Table Row in ONE pass)
// ═══════════════════════════════════════════════════════════════════════════════

/** posts.csv → posts table (has natural ID) */
export const posts = type({
	id: 'string',
	permalink: emptyToNull,
	date: dateToIso,
	ip: emptyToNull,
	subreddit: 'string',
	gildings: numericParse,
	'title?': 'string',
	'url?': 'string',
	'body?': 'string',
});

/** comments.csv → comments table (has natural ID) */
export const comments = type({
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
});

/** drafts.csv → drafts table (has natural ID) */
export const drafts = type({
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
});

/** post_votes.csv → post_votes table (has natural ID) */
export const post_votes = type({
	id: 'string',
	permalink: 'string',
	direction: voteDirection,
});

/** comment_votes.csv → comment_votes table (has natural ID) */
export const comment_votes = type({
	id: 'string',
	permalink: 'string',
	direction: voteDirection,
});

/** poll_votes.csv → poll_votes table (computed ID) */
export const poll_votes = type({
	post_id: 'string',
	'user_selection?': 'string',
	'text?': 'string',
	'image_url?': 'string',
	'is_prediction?': 'string',
	'stake_amount?': 'string',
}).pipe((row) => ({
	id: [
		row.post_id,
		row.user_selection ?? '',
		row.text ?? '',
		row.image_url ?? '',
		row.is_prediction ?? '',
		row.stake_amount ?? '',
	].join(':'),
	...row,
}));

/** saved_posts.csv → saved_posts table (has natural ID) */
export const saved_posts = type({
	id: 'string',
	permalink: 'string',
});

/** saved_comments.csv → saved_comments table (has natural ID) */
export const saved_comments = type({
	id: 'string',
	permalink: 'string',
});

/** hidden_posts.csv → hidden_posts table (has natural ID) */
export const hidden_posts = type({
	id: 'string',
	permalink: 'string',
});

/** messages.csv → messages table (has natural ID) */
export const messages = type({
	id: 'string',
	permalink: 'string',
	thread_id: optionalToNull,
	date: optionalDateToIso,
	ip: emptyToNull,
	'from?': 'string',
	'to?': 'string',
	'subject?': 'string',
	'body?': 'string',
});

/** messages_archive.csv → messages_archive table (has natural ID) */
export const messages_archive = messages;

/** chat_history.csv → chat_history table (rename message_id → id) */
export const chat_history = type({
	message_id: 'string',
	created_at: optionalDateToIso,
	updated_at: optionalDateToIso,
	username: optionalToNull,
	message: optionalToNull,
	thread_parent_message_id: optionalToNull,
	channel_url: optionalToNull,
	subreddit: optionalToNull,
	channel_name: optionalToNull,
	conversation_type: optionalToNull,
}).pipe(({ message_id, ...rest }) => ({
	id: message_id,
	...rest,
}));

/** subreddit CSVs → subreddit table (subreddit becomes ID) */
export const subreddit = type({
	subreddit: 'string',
}).pipe((row) => ({
	id: row.subreddit,
	subreddit: row.subreddit,
}));

// Aliases for the three subreddit tables
export const subscribed_subreddits = subreddit;
export const moderated_subreddits = subreddit;
export const approved_submitter_subreddits = subreddit;

/** multireddits.csv → multireddits table (has natural ID) */
export const multireddits = type({
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
});

/** gilded_content.csv → gilded_content table (computed ID) */
export const gilded_content = type({
	content_link: 'string',
	'award?': 'string',
	'amount?': 'string',
	date: optionalDateToIso,
}).pipe((row) => ({
	id: [row.content_link, row.date ?? '', row.award ?? '', row.amount ?? ''].join(
		':',
	),
	...row,
}));

/** gold_received.csv → gold_received table (computed ID) */
export const gold_received = type({
	content_link: 'string',
	'gold_received?': 'string',
	'gilder_username?': 'string',
	date: optionalDateToIso,
}).pipe((row) => ({
	id: [
		row.content_link,
		row.date ?? '',
		row.gold_received ?? '',
		row.gilder_username ?? '',
	].join(':'),
	...row,
}));

/** purchases.csv → purchases table (transaction_id becomes ID) */
export const purchases = type({
	'processor?': 'string',
	transaction_id: 'string',
	'product?': 'string',
	date: optionalDateToIso,
	'cost?': 'string',
	'currency?': 'string',
	'status?': 'string',
}).pipe((row) => ({
	id: row.transaction_id,
	...row,
}));

/** subscriptions.csv → subscriptions table (subscription_id becomes ID) */
export const subscriptions = type({
	'processor?': 'string',
	subscription_id: 'string',
	'product?': 'string',
	'product_id?': 'string',
	'product_name?': 'string',
	'status?': 'string',
	start_date: optionalDateToIso,
	end_date: optionalDateToIso,
}).pipe((row) => ({
	id: row.subscription_id,
	...row,
}));

/** payouts.csv → payouts table (computed ID with fallback) */
export const payouts = type({
	'payout_amount_usd?': 'string',
	date: 'string',
	'payout_id?': 'string',
}).pipe((row) => {
	// Parse date for both ID fallback and output
	const dateIso =
		!row.date || row.date === ''
			? null
			: (() => {
					const d = new Date(row.date);
					return Number.isNaN(d.getTime()) ? null : d.toISOString();
				})();
	return {
		id: row.payout_id ?? dateIso ?? row.date,
		date: dateIso,
		payout_id: row.payout_id,
		payout_amount_usd: row.payout_amount_usd,
	};
});

/** friends.csv → friends table (username becomes ID) */
export const friends = type({
	username: 'string',
	'note?': 'string',
}).pipe((row) => ({
	id: row.username,
	...row,
}));

/** linked_identities.csv → linked_identities table (computed ID) */
export const linked_identities = type({
	issuer_id: 'string',
	subject_id: 'string',
}).pipe((row) => ({
	id: `${row.issuer_id}:${row.subject_id}`,
	...row,
}));

/** announcements.csv → announcements table (announcement_id becomes ID) */
export const announcements = type({
	announcement_id: 'string',
	sent_at: optionalDateToIso,
	read_at: optionalDateToIso,
	from_id: optionalToNull,
	from_username: optionalToNull,
	subject: optionalToNull,
	body: optionalToNull,
	url: optionalToNull,
}).pipe((row) => ({
	id: row.announcement_id,
	...row,
}));

/** scheduled_posts.csv → scheduled_posts table (scheduled_post_id becomes ID) */
export const scheduled_posts = type({
	scheduled_post_id: 'string',
	'subreddit?': 'string',
	'title?': 'string',
	'body?': 'string',
	'url?': 'string',
	submission_time: optionalDateToIso,
	'recurrence?': 'string',
}).pipe((row) => ({
	id: row.scheduled_post_id,
	...row,
}));

/** ip_logs.csv → ip_logs table (computed ID) */
export const ip_logs = type({
	date: 'string',
	ip: 'string',
}).pipe((row) => ({
	id: `${row.date}:${row.ip}`,
	...row,
}));

/** sensitive_ads_preferences.csv → sensitive_ads_preferences table (type becomes ID) */
export const sensitive_ads_preferences = type({
	type: 'string',
	'preference?': 'string',
}).pipe((row) => ({
	id: row.type,
	...row,
}));

// ═══════════════════════════════════════════════════════════════════════════════
// KV SCHEMAS (singleton CSVs)
// ═══════════════════════════════════════════════════════════════════════════════

export const account_gender = type({ 'account_gender?': 'string' });
export const birthdate = type({
	'birthdate?': 'string',
	'verified_birthdate?': 'string',
});
export const statistics = type({ statistic: 'string', 'value?': 'string' });
export const user_preferences = type({
	preference: 'string',
	'value?': 'string',
});
export const linked_phone_number = type({ phone_number: 'string' });
export const stripe = type({ stripe_account_id: 'string' });
export const twitter = type({ username: 'string' });
export const persona = type({ persona_inquiry_id: 'string' });

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMA REGISTRY (for data-driven processing)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * All table schemas in a registry for data-driven processing.
 * Each schema takes raw CSV row → outputs table-ready row.
 */
export const csvSchemas = {
	posts,
	comments,
	drafts,
	post_votes,
	comment_votes,
	poll_votes,
	saved_posts,
	saved_comments,
	hidden_posts,
	messages,
	messages_archive,
	chat_history,
	subscribed_subreddits,
	moderated_subreddits,
	approved_submitter_subreddits,
	multireddits,
	gilded_content,
	gold_received,
	purchases,
	subscriptions,
	payouts,
	friends,
	linked_identities,
	announcements,
	scheduled_posts,
	ip_logs,
	sensitive_ads_preferences,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE EXPORTS (inferred from schemas)
// ═══════════════════════════════════════════════════════════════════════════════

export type PostRow = typeof posts.infer;
export type CommentRow = typeof comments.infer;
export type DraftRow = typeof drafts.infer;
export type PostVoteRow = typeof post_votes.infer;
export type CommentVoteRow = typeof comment_votes.infer;
export type PollVoteRow = typeof poll_votes.infer;
export type SavedPostRow = typeof saved_posts.infer;
export type SavedCommentRow = typeof saved_comments.infer;
export type HiddenPostRow = typeof hidden_posts.infer;
export type MessageRow = typeof messages.infer;
export type ChatHistoryRow = typeof chat_history.infer;
export type SubredditRow = typeof subreddit.infer;
export type MultiredditRow = typeof multireddits.infer;
export type GildedContentRow = typeof gilded_content.infer;
export type GoldReceivedRow = typeof gold_received.infer;
export type PurchaseRow = typeof purchases.infer;
export type SubscriptionRow = typeof subscriptions.infer;
export type PayoutRow = typeof payouts.infer;
export type FriendRow = typeof friends.infer;
export type LinkedIdentityRow = typeof linked_identities.infer;
export type AnnouncementRow = typeof announcements.infer;
export type ScheduledPostRow = typeof scheduled_posts.infer;
export type IpLogRow = typeof ip_logs.infer;
export type AdsPreferenceRow = typeof sensitive_ads_preferences.infer;
