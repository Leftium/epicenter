# Reddit GDPR Export Ingestion

Imports a Reddit data export ZIP into an Epicenter workspace. Reddit provides your data as a flat ZIP of CSV files when you [request a copy](https://support.reddithelp.com/hc/en-us/articles/360043048352).

## Architecture

```
parse.ts        → Phase 1: ZIP → raw CSV records (Record<csvKey, rows[]>)
csv-schemas.ts  → Phase 2: arktype schemas that validate + transform in one pass
workspace.ts    → Workspace definition (tables + KV store)
index.ts        → Orchestrator: wires parse → schema → workspace insertion
```

## CSV File Reference

A typical Reddit export contains **38 CSV files** (flat, no subdirectories). Every file is accounted for below.

Some exports include `messages.csv` + `message_headers.csv` instead of `messages_archive.csv` + `messages_archive_headers.csv`. The importer handles both variants.

### Tables (27 CSV files → 27 tables)

| CSV File | Table | ID Strategy | Description |
|---|---|---|---|
| `announcements.csv` | `announcements` | `announcement_id` | Reddit system announcements sent to you |
| `approved_submitter_subreddits.csv` | `approvedSubmitterSubreddits` | `subreddit` value | Subreddits where your posts are auto-approved |
| `chat_history.csv` | `chatHistory` | `message_id` (renamed to `id`) | Reddit chat messages sent/received |
| `comment_votes.csv` | `commentVotes` | Natural `id` | Every comment you upvoted/downvoted |
| `comments.csv` | `comments` | Natural `id` | Every comment you posted |
| `drafts.csv` | `drafts` | Natural `id` | Unsaved post drafts |
| `friends.csv` | `friends` | `username` value | Users you follow |
| `gilded_content.csv` | `gildedContent` | Composite: `link:date:award:amount` | Awards you gave to others |
| `gold_received.csv` | `goldReceived` | Composite: `link:date:gold:gilder` | Awards your content received |
| `hidden_posts.csv` | `hiddenPosts` | Natural `id` | Posts you hid from your feed |
| `ip_logs.csv` | `ipLogs` | Composite: `date:ip` | IP addresses you accessed Reddit from |
| `linked_identities.csv` | `linkedIdentities` | Composite: `issuer:subject` | Google/Apple sign-in connections |
| `messages.csv` | `messages` | Natural `id` | DMs sent/received (some exports use this) |
| `messages_archive.csv` | `messagesArchive` | Natural `id` | DMs sent/received (some exports use this instead) |
| `moderated_subreddits.csv` | `moderatedSubreddits` | `subreddit` value | Subreddits you moderate |
| `multireddits.csv` | `multireddits` | Natural `id` | Custom subreddit groups you created |
| `payouts.csv` | `payouts` | `payout_id` or date fallback | Money Reddit paid you |
| `poll_votes.csv` | `pollVotes` | Composite: `post:selection:text:img:pred:stake` | Polls you voted on |
| `post_votes.csv` | `postVotes` | Natural `id` | Every post you upvoted/downvoted |
| `posts.csv` | `posts` | Natural `id` | Every post you submitted |
| `purchases.csv` | `purchases` | `transaction_id` | Reddit purchases you made |
| `saved_comments.csv` | `savedComments` | Natural `id` | Comments you bookmarked |
| `saved_posts.csv` | `savedPosts` | Natural `id` | Posts you bookmarked |
| `scheduled_posts.csv` | `scheduledPosts` | `scheduled_post_id` | Queued future posts (moderator feature) |
| `sensitive_ads_preferences.csv` | `sensitiveAdsPreferences` | `type` value | Ad topic preferences |
| `subscribed_subreddits.csv` | `subscribedSubreddits` | `subreddit` value | Subreddits you're subscribed to |
| `subscriptions.csv` | `subscriptions` | `subscription_id` | Recurring Reddit payment subscriptions |

### KV Store (8 CSV files → 9 KV entries)

Singleton data (one value per account) goes into the KV store instead of tables.

| CSV File | KV Key(s) | Description |
|---|---|---|
| `account_gender.csv` | `accountGender` | Gender on your profile |
| `birthdate.csv` | `birthdate`, `verifiedBirthdate` | Your birthday (2 KV entries from 1 file) |
| `linked_phone_number.csv` | `phoneNumber` | Phone number linked to account |
| `persona.csv` | `personaInquiryId` | Identity verification request ID |
| `statistics.csv` | `statistics` | Account stats as key-value pairs (email, signup date, etc.) |
| `stripe.csv` | `stripeAccountId` | Connected Stripe payment account |
| `twitter.csv` | `twitterUsername` | Connected Twitter/X handle |
| `user_preferences.csv` | `preferences` | Account settings as key-value pairs |

### Excluded Files (5 CSV files, intentionally not stored)

These files are present in Reddit exports but are **not parsed or stored** because they contain no unique data.

| CSV File | Why Excluded |
|---|---|
| `checkfile.csv` | ZIP integrity checksums for tamper verification. Not user data. Only useful at download time to verify the archive wasn't corrupted. |
| `comment_headers.csv` | Strict subset of `comments.csv` (same rows, without the `body` column). 100% redundant. |
| `message_headers.csv` | Strict subset of `messages.csv` (same rows, without the `body` column). 100% redundant. |
| `messages_archive_headers.csv` | Strict subset of `messages_archive.csv` (same rows, without the `body` column). 100% redundant. |
| `post_headers.csv` | Strict subset of `posts.csv` (same rows, without the `body` column). 100% redundant. |

Reddit includes the `*_headers.csv` variants so users can review metadata (dates, subreddits, permalinks) without loading full post/comment/message bodies. Since we import the full files, the headers add zero value.

## Required vs Optional Files

The importer requires these 4 files to be present in the ZIP (throws if missing):

- `posts.csv`
- `comments.csv`
- `post_votes.csv`
- `comment_votes.csv`

`messages.csv` is explicitly optional (some exports use `messages_archive.csv` instead). All other files silently default to empty if absent.

## References

- [How do I request a copy of my Reddit data?](https://support.reddithelp.com/hc/en-us/articles/360043048352) - Official Reddit help article
- [reddit-gdpr-export-viewer](https://github.com/guilamu/reddit-gdpr-export-viewer) - Open-source viewer with confirmed column names
- [Archive Your Reddit Data](https://xavd.id/blog/post/archive-your-reddit-data/) - Community guide with export details
