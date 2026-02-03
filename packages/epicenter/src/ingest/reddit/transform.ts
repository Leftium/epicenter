/**
 * Reddit Transform Functions
 *
 * Phase 3 of the import pipeline: Transform validated CSV data → table rows.
 * Handles:
 * - Date → ISO string conversion
 * - undefined → null for optional fields
 * - Composite ID generation
 * - snake_case (CSV) → camelCase (table schema)
 */

import type { InferTableRow } from '../../static/index.js';
import type { ValidatedRedditExport } from './validation.js';
import { redditWorkspace } from './workspace.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Convert Date to ISO string or null */
function dateToIso(date: Date | undefined | null): string | null {
	return date?.toISOString() ?? null;
}

/** Convert string date to ISO string or null */
function parseDateToIso(dateStr: string | undefined | null): string | null {
	if (!dateStr || dateStr === '' || dateStr === 'registration ip') return null;
	try {
		const date = new Date(dateStr);
		if (isNaN(date.getTime())) return null;
		return date.toISOString();
	} catch {
		return null;
	}
}

/** Empty string → null */
function emptyToNull(value: string | undefined | null): string | null {
	if (value === undefined || value === null || value === '') return null;
	return value;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROW TYPES (derived from workspace schema - single source of truth)
// ═══════════════════════════════════════════════════════════════════════════════

type Tables = NonNullable<typeof redditWorkspace.tables>;

export type ContentRow = InferTableRow<Tables['content']>;
export type VoteRow = InferTableRow<Tables['votes']>;
export type SavedRow = InferTableRow<Tables['saved']>;
export type MessageRow = InferTableRow<Tables['messages']>;
export type ChatHistoryRow = InferTableRow<Tables['chatHistory']>;
export type SubredditRow = InferTableRow<Tables['subreddits']>;
export type MultiredditRow = InferTableRow<Tables['multireddits']>;
export type AwardRow = InferTableRow<Tables['awards']>;
export type CommerceRow = InferTableRow<Tables['commerce']>;
export type SocialRow = InferTableRow<Tables['social']>;
export type AnnouncementRow = InferTableRow<Tables['announcements']>;
export type ScheduledPostRow = InferTableRow<Tables['scheduledPosts']>;
export type IpLogRow = InferTableRow<Tables['ipLogs']>;
export type AdsPreferenceRow = InferTableRow<Tables['adsPreferences']>;

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSFORM FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export function transformContent(data: ValidatedRedditExport): ContentRow[] {
	const rows: ContentRow[] = [];

	// Posts
	for (const row of data.posts) {
		rows.push({
			id: row.id,
			type: 'post',
			permalink: row.permalink,
			date: dateToIso(row.date),
			ip: emptyToNull(row.ip),
			subreddit: row.subreddit,
			gildings: String(row.gildings),
			title: row.title,
			url: row.url,
			body: row.body,
		});
	}

	// Comments
	for (const row of data.comments) {
		rows.push({
			id: row.id,
			type: 'comment',
			permalink: row.permalink,
			date: dateToIso(row.date),
			ip: emptyToNull(row.ip),
			subreddit: row.subreddit,
			gildings: String(row.gildings),
			link: row.link,
			parent: row.parent,
			body: row.body,
			media: row.media,
		});
	}

	// Drafts
	for (const row of data.drafts) {
		rows.push({
			id: row.id,
			type: 'draft',
			permalink: null,
			date: parseDateToIso(row.created),
			ip: null,
			subreddit: emptyToNull(row.subreddit),
			gildings: null,
			title: row.title,
			body: row.body,
			kind: row.kind,
			spoiler: row.spoiler,
			nsfw: row.nsfw,
		});
	}

	return rows;
}

export function transformVotes(data: ValidatedRedditExport): VoteRow[] {
	const rows: VoteRow[] = [];

	// Post votes
	for (const row of data.post_votes) {
		rows.push({
			id: `post:${row.id}`,
			targetType: 'post',
			targetId: row.id,
			permalink: row.permalink,
			direction: row.direction,
		});
	}

	// Comment votes
	for (const row of data.comment_votes) {
		rows.push({
			id: `comment:${row.id}`,
			targetType: 'comment',
			targetId: row.id,
			permalink: row.permalink,
			direction: row.direction,
		});
	}

	// Poll votes
	for (const row of data.poll_votes) {
		rows.push({
			id: `poll:${row.post_id}`,
			targetType: 'poll',
			targetId: row.post_id,
			permalink: null,
			direction: null,
			userSelection: row.user_selection,
			text: row.text,
			isPrediction: row.is_prediction,
			stakeAmount: row.stake_amount,
		});
	}

	return rows;
}

export function transformSaved(data: ValidatedRedditExport): SavedRow[] {
	const rows: SavedRow[] = [];

	// Saved posts
	for (const row of data.saved_posts) {
		rows.push({
			id: `save:post:${row.id}`,
			action: 'save',
			targetType: 'post',
			targetId: row.id,
			permalink: row.permalink,
		});
	}

	// Saved comments
	for (const row of data.saved_comments) {
		rows.push({
			id: `save:comment:${row.id}`,
			action: 'save',
			targetType: 'comment',
			targetId: row.id,
			permalink: row.permalink,
		});
	}

	// Hidden posts
	for (const row of data.hidden_posts) {
		rows.push({
			id: `hide:post:${row.id}`,
			action: 'hide',
			targetType: 'post',
			targetId: row.id,
			permalink: row.permalink,
		});
	}

	return rows;
}

export function transformMessages(data: ValidatedRedditExport): MessageRow[] {
	const rows: MessageRow[] = [];

	// Active messages (may be undefined if file absent)
	for (const row of data.messages ?? []) {
		rows.push({
			id: row.id,
			archived: false,
			permalink: row.permalink,
			threadId: emptyToNull(row.thread_id),
			date: parseDateToIso(row.date),
			ip: emptyToNull(row.ip),
			from: row.from,
			to: row.to,
			subject: row.subject,
			body: row.body,
		});
	}

	// Archived messages
	for (const row of data.messages_archive) {
		rows.push({
			id: row.id,
			archived: true,
			permalink: row.permalink,
			threadId: emptyToNull(row.thread_id),
			date: parseDateToIso(row.date),
			ip: emptyToNull(row.ip),
			from: row.from,
			to: row.to,
			subject: row.subject,
			body: row.body,
		});
	}

	return rows;
}

export function transformChatHistory(data: ValidatedRedditExport): ChatHistoryRow[] {
	return data.chat_history.map((row) => ({
		id: row.message_id,
		createdAt: parseDateToIso(row.created_at),
		updatedAt: parseDateToIso(row.updated_at),
		username: emptyToNull(row.username),
		message: emptyToNull(row.message),
		threadParentMessageId: emptyToNull(row.thread_parent_message_id),
		channelUrl: emptyToNull(row.channel_url),
		subreddit: emptyToNull(row.subreddit),
		channelName: emptyToNull(row.channel_name),
		conversationType: emptyToNull(row.conversation_type),
	}));
}

export function transformSubreddits(data: ValidatedRedditExport): SubredditRow[] {
	const rows: SubredditRow[] = [];

	for (const row of data.subscribed_subreddits) {
		rows.push({
			id: `subscribed:${row.subreddit}`,
			subreddit: row.subreddit,
			role: 'subscribed',
		});
	}

	for (const row of data.moderated_subreddits) {
		rows.push({
			id: `moderated:${row.subreddit}`,
			subreddit: row.subreddit,
			role: 'moderated',
		});
	}

	for (const row of data.approved_submitter_subreddits) {
		rows.push({
			id: `approved_submitter:${row.subreddit}`,
			subreddit: row.subreddit,
			role: 'approved_submitter',
		});
	}

	return rows;
}

export function transformMultireddits(data: ValidatedRedditExport): MultiredditRow[] {
	return data.multireddits.map((row) => ({
		id: row.id,
		displayName: emptyToNull(row.display_name),
		date: parseDateToIso(row.date),
		description: emptyToNull(row.description),
		privacy: emptyToNull(row.privacy),
		subreddits: emptyToNull(row.subreddits),
		imageUrl: emptyToNull(row.image_url),
		isOwner: emptyToNull(row.is_owner),
		favorited: emptyToNull(row.favorited),
		followers: emptyToNull(row.followers),
	}));
}

export function transformAwards(data: ValidatedRedditExport): AwardRow[] {
	const rows: AwardRow[] = [];

	// Gilded content (given)
	for (const row of data.gilded_content) {
		rows.push({
			id: `given:${row.content_link}`,
			direction: 'given',
			contentLink: row.content_link,
			award: emptyToNull(row.award),
			amount: emptyToNull(row.amount),
			date: parseDateToIso(row.date),
		});
	}

	// Gold received
	for (const row of data.gold_received) {
		rows.push({
			id: `received:${row.content_link}`,
			direction: 'received',
			contentLink: row.content_link,
			award: emptyToNull(row.gold_received),
			amount: null,
			date: parseDateToIso(row.date),
			gilderUsername: row.gilder_username,
		});
	}

	return rows;
}

export function transformCommerce(data: ValidatedRedditExport): CommerceRow[] {
	const rows: CommerceRow[] = [];

	// Purchases
	for (const row of data.purchases) {
		rows.push({
			id: `purchase:${row.transaction_id}`,
			type: 'purchase',
			date: parseDateToIso(row.date),
			processor: row.processor,
			transactionId: row.transaction_id,
			product: row.product,
			cost: row.cost,
			currency: row.currency,
			status: row.status,
		});
	}

	// Subscriptions
	for (const row of data.subscriptions) {
		rows.push({
			id: `subscription:${row.subscription_id}`,
			type: 'subscription',
			date: null,
			subscriptionId: row.subscription_id,
			productId: row.product_id,
			productName: row.product_name,
			status: row.status,
			startDate: parseDateToIso(row.start_date) ?? undefined,
			endDate: parseDateToIso(row.end_date) ?? undefined,
		});
	}

	// Payouts
	for (const row of data.payouts) {
		rows.push({
			id: `payout:${row.payout_id ?? row.date}`,
			type: 'payout',
			date: parseDateToIso(row.date),
			payoutId: row.payout_id,
			payoutAmountUsd: row.payout_amount_usd,
		});
	}

	return rows;
}

export function transformSocial(data: ValidatedRedditExport): SocialRow[] {
	const rows: SocialRow[] = [];

	// Friends
	for (const row of data.friends) {
		rows.push({
			id: `friend:${row.username}`,
			type: 'friend',
			username: row.username,
			note: row.note,
		});
	}

	// Linked identities
	for (const row of data.linked_identities) {
		rows.push({
			id: `linked_identity:${row.issuer_id}:${row.subject_id}`,
			type: 'linked_identity',
			issuerId: row.issuer_id,
			subjectId: row.subject_id,
		});
	}

	return rows;
}

export function transformAnnouncements(data: ValidatedRedditExport): AnnouncementRow[] {
	return data.announcements.map((row) => ({
		id: row.announcement_id,
		sentAt: parseDateToIso(row.sent_at),
		readAt: parseDateToIso(row.read_at),
		fromId: emptyToNull(row.from_id),
		fromUsername: emptyToNull(row.from_username),
		subject: emptyToNull(row.subject),
		body: emptyToNull(row.body),
		url: emptyToNull(row.url),
	}));
}

export function transformScheduledPosts(data: ValidatedRedditExport): ScheduledPostRow[] {
	return data.scheduled_posts.map((row) => ({
		id: row.scheduled_post_id,
		subreddit: emptyToNull(row.subreddit),
		title: emptyToNull(row.title),
		body: emptyToNull(row.body),
		url: emptyToNull(row.url),
		submissionTime: parseDateToIso(row.submission_time),
		recurrence: emptyToNull(row.recurrence),
	}));
}

export function transformIpLogs(data: ValidatedRedditExport): IpLogRow[] {
	return data.ip_logs.map((row) => ({
		id: `${parseDateToIso(row.date) ?? 'unknown'}:${row.ip}`,
		date: parseDateToIso(row.date) ?? '',
		ip: row.ip,
	}));
}

export function transformAdsPreferences(data: ValidatedRedditExport): AdsPreferenceRow[] {
	return data.sensitive_ads_preferences.map((row) => ({
		id: row.type,
		type: row.type,
		preference: emptyToNull(row.preference),
	}));
}

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
			if (row.statistic && row.value) {
				statistics[row.statistic] = row.value;
			}
		}
	}

	// Preferences → JSON object
	let preferences: Record<string, string> | null = null;
	if (data.user_preferences.length > 0) {
		preferences = {};
		for (const row of data.user_preferences) {
			if (row.preference && row.value) {
				preferences[row.preference] = row.value;
			}
		}
	}

	return {
		accountGender: emptyToNull(data.account_gender[0]?.account_gender),
		birthdate: parseDateToIso(data.birthdate[0]?.birthdate),
		verifiedBirthdate: parseDateToIso(data.birthdate[0]?.verified_birthdate),
		phoneNumber: emptyToNull(data.linked_phone_number[0]?.phone_number),
		stripeAccountId: emptyToNull(data.stripe[0]?.stripe_account_id),
		personaInquiryId: emptyToNull(data.persona[0]?.persona_inquiry_id),
		twitterUsername: emptyToNull(data.twitter[0]?.username),
		statistics,
		preferences,
	};
}

// ═══════════════════════════════════════════════════════════════════════════════
// TABLE TRANSFORMS REGISTRY
// ═══════════════════════════════════════════════════════════════════════════════

/** Transform configurations for data-driven imports */
export const tableTransforms = [
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
