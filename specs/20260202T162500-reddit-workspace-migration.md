# Ingest Package Specification

> A reusable data import library for multiple platforms (Reddit, Twitter, Google Takeout, etc.) using Y.Doc as the single source of truth.

## Status: Draft (Updated)

## Background

### Current Architecture

```
vault-core                              demo-mcp
-------------------------------------------
- SQLite as source of truth             - CLI wrapper
- Drizzle ORM for schema                - Commands: import, export-fs
- DDL migrations                        - MCP integration via Turso
- 40+ over-normalized tables
- Adapters (reddit, entity_index)
- Ingestors (ZIP parsing)
- Codecs (JSON, Markdown)
```

### Target Architecture

```
packages/ingest/                        packages/epicenter/
----------------------------------------------
- Platform importers (reddit, twitter)  - Y.Doc as source of truth
- Functional defineImporter() API       - SQLite extension (queries)
- yargs CLI                             - Markdown extension (persistence)
- Consolidated schemas (~8 tables)      - Capability pattern
```

## Goals

1. **Reusable import library**: Support multiple platforms with consistent API
2. **Functional patterns**: Use `defineImporter()` factory, no classes
3. **Consolidated schemas**: ~8 tables instead of 40 (type discriminators, nested JSON)
4. **yargs CLI**: Follow existing patterns in `packages/epicenter/src/cli/`
5. **Y.Doc as truth**: Use epicenter/static workspace system

## Non-Goals

1. Backward compatibility with vault-core SQLite format
2. MCP integration (separate layer)
3. DDL migrations (epicenter uses read-time migrations)

## Design

### 1. Package Structure

```
packages/ingest/
├── src/
│   ├── index.ts                    # Public exports
│   ├── importer.ts                 # defineImporter() factory
│   ├── types.ts                    # Shared types
│   │
│   ├── platforms/
│   │   ├── reddit/
│   │   │   ├── index.ts            # Export redditImporter
│   │   │   ├── importer.ts         # defineImporter({ ... })
│   │   │   ├── schema.ts           # Consolidated 8-table schema
│   │   │   ├── parse.ts            # ZIP/CSV parsing (ported)
│   │   │   └── transform.ts        # CSV → table row transforms
│   │   │
│   │   └── twitter/                # Future
│   │       └── ...
│   │
│   ├── utils/
│   │   ├── archive/
│   │   │   └── zip.ts              # ZIP unpacking (ported)
│   │   └── format/
│   │       └── csv.ts              # CSV parsing (ported)
│   │
│   └── cli/
│       ├── bin.ts                  # Entry point
│       └── cli.ts                  # yargs CLI
│
├── package.json
└── tsconfig.json
```

### 2. Importer API

The importer is a **functional factory** that returns an object with lifecycle methods. No classes.

````typescript
// packages/ingest/src/importer.ts

import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * Importer definition config
 */
type ImporterConfig<TPreview, TStats> = {
	/** Unique identifier for this importer */
	id: string;

	/** Human-readable name */
	name: string;

	/** File extensions this importer handles (e.g., ['.zip']) */
	extensions: string[];

	/**
	 * Check if a file matches this importer.
	 * Called before import to validate the file.
	 */
	matches: (file: File | Blob, filename: string) => boolean | Promise<boolean>;

	/**
	 * Preview what will be imported without modifying state.
	 * Returns stats about the file contents.
	 */
	preview: (file: File | Blob) => Promise<TPreview>;

	/**
	 * Import file contents into the workspace.
	 * Returns stats about what was imported.
	 */
	import: (
		file: File | Blob,
		workspace: WorkspaceClient,
		options?: ImportOptions,
	) => Promise<TStats>;
};

type ImportOptions = {
	/** If true, skip rows that fail validation instead of erroring */
	skipInvalid?: boolean;

	/** Progress callback */
	onProgress?: (progress: ImportProgress) => void;
};

type ImportProgress = {
	phase: 'unpack' | 'parse' | 'import';
	current: number;
	total: number;
	table?: string;
};

/**
 * Importer instance returned by defineImporter
 */
type Importer<TPreview, TStats> = {
	id: string;
	name: string;
	extensions: string[];
	matches: (file: File | Blob, filename: string) => boolean | Promise<boolean>;
	preview: (file: File | Blob) => Promise<TPreview>;
	import: (
		file: File | Blob,
		workspace: WorkspaceClient,
		options?: ImportOptions,
	) => Promise<TStats>;
};

/**
 * Define a platform importer.
 *
 * @example
 * ```typescript
 * const redditImporter = defineImporter({
 *   id: 'reddit',
 *   name: 'Reddit GDPR Export',
 *   extensions: ['.zip'],
 *   matches: (file, filename) => filename.endsWith('.zip'),
 *   preview: async (file) => { ... },
 *   import: async (file, workspace, options) => { ... },
 * });
 * ```
 */
export function defineImporter<TPreview, TStats>(
	config: ImporterConfig<TPreview, TStats>,
): Importer<TPreview, TStats> {
	return {
		id: config.id,
		name: config.name,
		extensions: config.extensions,
		matches: config.matches,
		preview: config.preview,
		import: config.import,
	};
}
````

### 3. Reddit Importer

```typescript
// packages/ingest/src/platforms/reddit/importer.ts

import { defineImporter } from '../../importer';
import { parseRedditZip, type RedditExportData } from './parse';
import { transformToRows } from './transform';
import type { RedditPreview, RedditImportStats } from './types';

export const redditImporter = defineImporter<RedditPreview, RedditImportStats>({
	id: 'reddit',
	name: 'Reddit GDPR Export',
	extensions: ['.zip'],

	matches(file, filename) {
		return filename.endsWith('.zip');
	},

	async preview(file) {
		const data = await parseRedditZip(file);

		return {
			username: data.accountInfo?.username,
			tables: {
				content: data.posts.length + data.comments.length + data.drafts.length,
				interactions:
					data.postVotes.length +
					data.commentVotes.length +
					data.savedPosts.length +
					data.savedComments.length +
					data.hiddenPosts.length,
				messages: data.messages.length + data.chatHistory.length,
				subreddits:
					data.subscribedSubreddits.length +
					data.moderatedSubreddits.length +
					data.approvedSubmitterSubreddits.length,
				multireddits: data.multireddits.length,
				social: data.friends.length + data.linkedIdentities.length,
				awards: data.gildingsGiven.length + data.gildingsReceived.length,
				commerce: data.purchases.length + data.subscriptions.length,
			},
			hasKv: {
				gender: !!data.accountGender,
				birthdate: !!data.birthdate,
				statistics: !!data.statistics,
			},
		};
	},

	async import(file, workspace, options) {
		const data = await parseRedditZip(file);
		const stats: RedditImportStats = {
			tables: {},
			totalRows: 0,
			skipped: 0,
			errors: [],
		};

		// Transform and import each table
		workspace.ydoc.transact(() => {
			// Content table (posts, comments, drafts)
			const contentRows = transformToRows.content(data);
			for (const row of contentRows) {
				workspace.tables.content.upsert(row);
				stats.totalRows++;
			}
			stats.tables.content = contentRows.length;

			// Interactions table (votes, saves, hides)
			const interactionRows = transformToRows.interactions(data);
			for (const row of interactionRows) {
				workspace.tables.interactions.upsert(row);
				stats.totalRows++;
			}
			stats.tables.interactions = interactionRows.length;

			// ... other tables

			// KV data
			if (data.accountGender) {
				workspace.kv.set('account_gender', data.accountGender);
			}
			if (data.birthdate) {
				workspace.kv.set('birthdate', data.birthdate);
			}
			if (data.statistics) {
				workspace.kv.set('statistics', data.statistics);
			}
		});

		return stats;
	},
});
```

### 4. Consolidated Reddit Schema

**Before**: 40+ tables (many `_headers` variants, separate tables for each action type)

**After**: 8 tables + KV store using type discriminators and nested JSON

```typescript
// packages/ingest/src/platforms/reddit/schema.ts

import {
	defineWorkspace,
	id,
	text,
	date,
	integer,
	select,
	json,
	tags,
} from '@epicenter/hq';
import { type } from 'arktype';

/**
 * Reddit GDPR Export Workspace
 *
 * Consolidated from vault-core's 40+ tables to 8 tables + KV.
 * Uses type discriminators and nested JSON for related data.
 */
export const redditWorkspace = defineWorkspace({
	id: 'reddit',

	tables: {
		// =========================================================================
		// CONTENT: Posts, comments, drafts
		// =========================================================================
		content: {
			id: id(),
			type: select({ options: ['post', 'comment', 'draft'] }),
			permalink: text({ nullable: true }),
			date: date({ nullable: true }),
			ip: text({ nullable: true }),
			subreddit: text({ nullable: true }),
			gildings: integer({ nullable: true }),

			// Post-specific
			title: text({ nullable: true }),
			url: text({ nullable: true }),

			// Comment-specific
			link: text({ nullable: true }), // Parent post URL
			parent: text({ nullable: true }), // Parent comment ID

			// Shared
			body: text({ nullable: true }),
			media: text({ nullable: true }),
		},

		// =========================================================================
		// INTERACTIONS: Votes, saves, hides
		// =========================================================================
		interactions: {
			id: id(),
			type: select({
				options: [
					'post_vote',
					'comment_vote',
					'save_post',
					'save_comment',
					'hide_post',
				],
			}),
			targetId: text(), // The post/comment ID
			permalink: text(),
			direction: select({ options: ['up', 'down', 'none'], nullable: true }), // For votes
			date: date({ nullable: true }),
		},

		// =========================================================================
		// MESSAGES: DMs and chat history
		// =========================================================================
		messages: {
			id: id(),
			type: select({ options: ['dm', 'dm_archive', 'chat'] }),
			permalink: text({ nullable: true }),
			threadId: text({ nullable: true }),
			date: date({ nullable: true }),
			ip: text({ nullable: true }),

			// DM-specific
			from: text({ nullable: true }),
			to: text({ nullable: true }),
			subject: text({ nullable: true }),

			// Chat-specific
			username: text({ nullable: true }),
			channelUrl: text({ nullable: true }),
			channelName: text({ nullable: true }),
			conversationType: text({ nullable: true }),
			threadParentMessageId: text({ nullable: true }),

			// Shared
			body: text({ nullable: true }),
			archived: boolean({ default: false }), // For dm_archive
		},

		// =========================================================================
		// SUBREDDITS: Subscriptions, moderation, approved submitter
		// =========================================================================
		subreddits: {
			id: id(), // subreddit name as ID
			relationship: select({
				options: ['subscribed', 'moderated', 'approved_submitter'],
			}),
		},

		// =========================================================================
		// MULTIREDDITS: Custom feeds
		// =========================================================================
		multireddits: {
			id: id(),
			name: text(),
			subreddits: tags(), // Array of subreddit names
			visibility: select({ options: ['public', 'private'], nullable: true }),
			description: text({ nullable: true }),
		},

		// =========================================================================
		// SOCIAL: Friends and linked accounts
		// =========================================================================
		social: {
			id: id(),
			type: select({ options: ['friend', 'linked_identity'] }),
			username: text({ nullable: true }),
			note: text({ nullable: true }),

			// Linked identity specific
			platform: text({ nullable: true }),
			platformId: text({ nullable: true }),
			verified: boolean({ nullable: true }),
		},

		// =========================================================================
		// AWARDS: Gilding given/received
		// =========================================================================
		awards: {
			id: id(),
			type: select({ options: ['given', 'received'] }),
			awardType: text({ nullable: true }),
			permalink: text({ nullable: true }),
			date: date({ nullable: true }),
			amount: integer({ nullable: true }),
			comment: text({ nullable: true }),
		},

		// =========================================================================
		// COMMERCE: Purchases and subscriptions (often empty)
		// =========================================================================
		commerce: {
			id: id(),
			type: select({ options: ['purchase', 'subscription'] }),

			// Purchase-specific
			transactionId: text({ nullable: true }),
			processor: text({ nullable: true }),
			product: text({ nullable: true }),
			cost: text({ nullable: true }),
			currency: text({ nullable: true }),
			status: text({ nullable: true }),

			// Subscription-specific
			subscriptionId: text({ nullable: true }),
			startDate: date({ nullable: true }),
			endDate: date({ nullable: true }),
			cancelDate: date({ nullable: true }),
			renewalDate: date({ nullable: true }),

			date: date({ nullable: true }),
		},
	},

	// ===========================================================================
	// KV: Singleton data
	// ===========================================================================
	kv: {
		account_gender: text({ nullable: true }),
		birthdate: date({ nullable: true }),
		verified_birthdate: date({ nullable: true }),
		email: text({ nullable: true }),
		statistics: json({
			schema: type({
				'account_created_at?': 'string',
				'karma?': 'number',
				'post_karma?': 'number',
				'comment_karma?': 'number',
				// ... other stats
			}),
			nullable: true,
		}),
		preferences: json({
			schema: type({
				'[string]': 'string',
			}),
			nullable: true,
		}),
	},
});

export type RedditWorkspace = typeof redditWorkspace;
```

### 5. CLI Using yargs

Following existing patterns from `packages/epicenter/src/cli/`:

```typescript
// packages/ingest/src/cli/cli.ts

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { redditImporter } from '../platforms/reddit';
import { createWorkspaceClient } from '../workspace';

type CLIOptions = {
	projectDir?: string;
	epicenterDir?: string;
};

export function createIngestCLI(options?: CLIOptions) {
	const projectDir = options?.projectDir ?? process.cwd();
	const epicenterDir = options?.epicenterDir ?? `${projectDir}/.epicenter`;

	return (
		yargs(hideBin(process.argv))
			.scriptName('ingest')
			.usage('Usage: $0 <command> [options]')
			.help()
			.version()
			.strict()

			// =========================================================================
			// import <platform> <file>
			// =========================================================================
			.command(
				'import <platform> <file>',
				'Import data from a platform export',
				(yargs) =>
					yargs
						.positional('platform', {
							type: 'string',
							choices: ['reddit', 'twitter'] as const,
							description: 'Platform to import from',
						})
						.positional('file', {
							type: 'string',
							description: 'Path to export file (ZIP)',
						})
						.option('skip-invalid', {
							type: 'boolean',
							default: false,
							description: 'Skip rows that fail validation',
						}),
				async (argv) => {
					const { platform, file, skipInvalid } = argv;

					// Select importer
					const importer = platform === 'reddit' ? redditImporter : null;
					if (!importer) {
						console.error(`Unknown platform: ${platform}`);
						process.exit(1);
					}

					// Create workspace client
					const client = await createWorkspaceClient(importer.id, {
						projectDir,
						epicenterDir,
					});

					try {
						// Read file
						const blob = Bun.file(file!);

						// Check if file matches
						const matches = await importer.matches(blob, file!);
						if (!matches) {
							console.error(`File does not match ${importer.name} format`);
							process.exit(1);
						}

						// Import
						console.log(`Importing ${file} using ${importer.name}...`);
						const stats = await importer.import(blob, client, {
							skipInvalid,
							onProgress: (p) => {
								process.stdout.write(`\r${p.phase}: ${p.current}/${p.total}`);
							},
						});

						console.log('\n');
						console.log(`Imported ${stats.totalRows} total rows:`);
						for (const [table, count] of Object.entries(stats.tables)) {
							console.log(`  ${table}: ${count}`);
						}
						if (stats.skipped > 0) {
							console.log(`  (skipped ${stats.skipped} invalid rows)`);
						}
					} finally {
						await client.destroy();
					}
				},
			)

			// =========================================================================
			// preview <platform> <file>
			// =========================================================================
			.command(
				'preview <platform> <file>',
				'Preview what will be imported without importing',
				(yargs) =>
					yargs
						.positional('platform', {
							type: 'string',
							choices: ['reddit', 'twitter'] as const,
							description: 'Platform to preview',
						})
						.positional('file', {
							type: 'string',
							description: 'Path to export file (ZIP)',
						}),
				async (argv) => {
					const { platform, file } = argv;

					const importer = platform === 'reddit' ? redditImporter : null;
					if (!importer) {
						console.error(`Unknown platform: ${platform}`);
						process.exit(1);
					}

					const blob = Bun.file(file!);
					const preview = await importer.preview(blob);

					console.log(`\n${importer.name} Export Preview:`);
					console.log(JSON.stringify(preview, null, 2));
				},
			)

			// =========================================================================
			// pull
			// =========================================================================
			.command(
				'pull <platform>',
				'Sync Y.Doc to SQLite and Markdown',
				(yargs) =>
					yargs.positional('platform', {
						type: 'string',
						choices: ['reddit', 'twitter'] as const,
					}),
				async (argv) => {
					const client = await createWorkspaceClient(argv.platform!, {
						projectDir,
						epicenterDir,
					});

					try {
						await client.extensions.sqlite?.pullToSqlite();
						await client.extensions.markdown?.pullToMarkdown();
						console.log('Pulled Y.Doc to SQLite and Markdown');
					} finally {
						await client.destroy();
					}
				},
			)

			// =========================================================================
			// push
			// =========================================================================
			.command(
				'push <platform>',
				'Sync Markdown to Y.Doc',
				(yargs) =>
					yargs.positional('platform', {
						type: 'string',
						choices: ['reddit', 'twitter'] as const,
					}),
				async (argv) => {
					const client = await createWorkspaceClient(argv.platform!, {
						projectDir,
						epicenterDir,
					});

					try {
						await client.extensions.markdown?.pushFromMarkdown();
						console.log('Pushed Markdown to Y.Doc');
					} finally {
						await client.destroy();
					}
				},
			)

			// =========================================================================
			// stats
			// =========================================================================
			.command(
				'stats <platform>',
				'Show row counts per table',
				(yargs) =>
					yargs.positional('platform', {
						type: 'string',
						choices: ['reddit', 'twitter'] as const,
					}),
				async (argv) => {
					const client = await createWorkspaceClient(argv.platform!, {
						projectDir,
						epicenterDir,
					});

					try {
						console.log('\nTable row counts:');
						for (const [tableName, table] of Object.entries(client.tables)) {
							const count = table.count();
							if (count > 0) {
								console.log(`  ${tableName}: ${count}`);
							}
						}
					} finally {
						await client.destroy();
					}
				},
			)
	);
}
```

```typescript
// packages/ingest/src/cli/bin.ts
#!/usr/bin/env bun

import { createIngestCLI } from './cli';

createIngestCLI().parse();
```

### 6. Workspace Client Factory

````typescript
// packages/ingest/src/workspace.ts

import { createClient, sqliteProvider, markdownProvider } from '@epicenter/hq';
import { setupPersistence } from '@epicenter/hq/providers';
import { redditWorkspace } from './platforms/reddit/schema';

const workspaces = {
	reddit: redditWorkspace,
	// twitter: twitterWorkspace,  // Future
} as const;

type WorkspaceId = keyof typeof workspaces;

type WorkspaceClientOptions = {
	projectDir: string;
	epicenterDir: string;
};

/**
 * Create a workspace client for a platform.
 *
 * @example
 * ```typescript
 * const client = await createWorkspaceClient('reddit', {
 *   projectDir: '/Users/me/vault',
 *   epicenterDir: '/Users/me/vault/.epicenter',
 * });
 *
 * // Import data
 * await redditImporter.import(file, client);
 *
 * // Query via SQLite
 * const posts = await client.extensions.sqlite.content
 *   .select()
 *   .where(eq(content.type, 'post'));
 *
 * // Cleanup
 * await client.destroy();
 * ```
 */
export async function createWorkspaceClient(
	id: WorkspaceId,
	options: WorkspaceClientOptions,
) {
	const workspace = workspaces[id];
	const { projectDir, epicenterDir } = options;

	return createClient(workspace.id)
		.withDefinition(workspace)
		.withExtensions({
			persistence: setupPersistence,

			sqlite: (ctx) =>
				sqliteProvider(ctx, {
					dbPath: `${epicenterDir}/sqlite/${id}.db`,
				}),

			markdown: (ctx) =>
				markdownProvider(ctx, {
					directory: `${projectDir}/${id}`,
					tableConfigs: {
						content: {
							serialize: ({ row }) => ({
								frontmatter: {
									type: row.type,
									subreddit: row.subreddit,
									date: row.date,
									...(row.type === 'post' && {
										title: row.title,
										url: row.url,
									}),
									...(row.type === 'comment' && {
										link: row.link,
										parent: row.parent,
									}),
								},
								body: row.body ?? '',
								filename: `${row.type}/${row.id}.md`,
							}),
						},
						messages: {
							serialize: ({ row }) => ({
								frontmatter: {
									type: row.type,
									from: row.from,
									to: row.to,
									date: row.date,
									subject: row.subject,
								},
								body: row.body ?? '',
								filename: `${row.type}/${row.id}.md`,
							}),
						},
					},
				}),
		});
}

export type WorkspaceClient = Awaited<ReturnType<typeof createWorkspaceClient>>;
````

## Data Flow

### Import Flow

```
┌──────────────┐
│ Platform     │  (Reddit GDPR ZIP, Twitter archive, etc.)
│ Export File  │
└──────┬───────┘
       │ importer.import(file, workspace)
       ▼
┌──────────────┐
│ Parse        │  Unpack ZIP, parse CSV files
│ (platform-   │
│  specific)   │
└──────┬───────┘
       │ transformToRows()
       ▼
┌──────────────┐
│ Transform    │  CSV rows → consolidated table rows
│              │  (type discriminators, nested JSON)
└──────┬───────┘
       │ workspace.ydoc.transact()
       ▼
┌──────────────┐
│   Y.Doc      │  ← SOURCE OF TRUTH
│   (CRDTs)    │
└──────┬───────┘
       │ Automatic sync via observers
       ├────────────────┬──────────────────┐
       ▼                ▼                  ▼
┌──────────────┐ ┌──────────────┐  ┌──────────────┐
│   SQLite     │ │   Markdown   │  │  Persistence │
│   (.db)      │ │   (.md)      │  │   (.yjs)     │
└──────────────┘ └──────────────┘  └──────────────┘
```

### Query Flow

```
┌──────────────┐
│ SQL Query    │  client.extensions.sqlite.content
│ (Drizzle)    │    .select().where(eq(content.type, 'post'))
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   SQLite     │  Query the derived index
│   (.db)      │
└──────────────┘
```

## Schema Consolidation Details

### Before: vault-core's 40+ Tables

```
posts, post_headers
comments, comment_headers
post_votes, comment_votes
saved_posts, saved_comments
hidden_posts
messages, messages_archive
chat_history
user_preferences
subscribed_subreddits, moderated_subreddits, approved_submitter_subreddits
multireddits
friends
linked_identities
gildings_given, gildings_received
purchases, subscriptions
drafts
... and more
```

### After: 8 Tables + KV

| Table          | Consolidates                                                         | Discriminator                                                                         |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `content`      | posts, comments, drafts                                              | `type: 'post' \| 'comment' \| 'draft'`                                                |
| `interactions` | post_votes, comment_votes, saved_posts, saved_comments, hidden_posts | `type: 'post_vote' \| 'comment_vote' \| 'save_post' \| 'save_comment' \| 'hide_post'` |
| `messages`     | messages, messages_archive, chat_history                             | `type: 'dm' \| 'dm_archive' \| 'chat'`                                                |
| `subreddits`   | subscribed, moderated, approved_submitter                            | `relationship: 'subscribed' \| 'moderated' \| 'approved_submitter'`                   |
| `multireddits` | multireddits                                                         | -                                                                                     |
| `social`       | friends, linked_identities                                           | `type: 'friend' \| 'linked_identity'`                                                 |
| `awards`       | gildings_given, gildings_received                                    | `type: 'given' \| 'received'`                                                         |
| `commerce`     | purchases, subscriptions                                             | `type: 'purchase' \| 'subscription'`                                                  |

**KV Store** (singleton data):

- `account_gender`
- `birthdate`
- `verified_birthdate`
- `email`
- `statistics` (JSON)
- `preferences` (JSON)

### Why Consolidate?

1. **Simpler mental model**: 8 tables vs 40+
2. **Flexible queries**: Filter by `type` discriminator
3. **Easier migrations**: Add new types without schema changes
4. **Less redundancy**: No `_headers` tables (just query fewer fields)
5. **Nested JSON**: Complex data in `statistics`, `preferences`

## Migration Path

### Phase 1: Port Utilities (2 hours)

- [ ] Create `packages/ingest/` structure
- [ ] Port `packages/vault-core/src/utils/archive/zip` → `packages/ingest/src/utils/archive/zip`
- [ ] Port `packages/vault-core/src/utils/format/csv` → `packages/ingest/src/utils/format/csv`
- [ ] Add tests

### Phase 2: Implement Reddit Importer (4-6 hours)

- [ ] Create `defineImporter()` factory
- [ ] Define consolidated Reddit schema (8 tables)
- [ ] Port ZIP/CSV parsing from vault-core
- [ ] Implement transform functions (CSV → consolidated rows)
- [ ] Create workspace client factory
- [ ] Add tests

### Phase 3: CLI (2 hours)

- [ ] Create yargs CLI following epicenter patterns
- [ ] Add `import`, `preview`, `pull`, `push`, `stats` commands
- [ ] Add bin entry point
- [ ] Test with real Reddit export

### Phase 4: Integration Testing (2 hours)

- [ ] Import real Reddit export
- [ ] Verify Y.Doc data
- [ ] Verify SQLite queries
- [ ] Verify Markdown files
- [ ] Verify edit flow (MD → Y.Doc → SQLite)

### Phase 5: Cleanup (1 hour)

- [ ] Deprecate `packages/vault-core`
- [ ] Remove `apps/demo-mcp`
- [ ] Update documentation

**Total: ~12 hours**

## API Reference

### `defineImporter<TPreview, TStats>(config)`

Create a platform importer.

```typescript
const myImporter = defineImporter({
  id: 'myplatform',
  name: 'My Platform Export',
  extensions: ['.zip'],
  matches: (file, filename) => filename.endsWith('.zip'),
  preview: async (file) => ({ ... }),
  import: async (file, workspace, options) => ({ ... }),
});
```

### `createWorkspaceClient(id, options)`

Create a workspace client with persistence, SQLite, and Markdown extensions.

```typescript
const client = await createWorkspaceClient('reddit', {
	projectDir: '/path/to/project',
	epicenterDir: '/path/to/project/.epicenter',
});
```

### CLI Commands

```bash
# Import a platform export
ingest import reddit ./export.zip
ingest import reddit ./export.zip --skip-invalid

# Preview without importing
ingest preview reddit ./export.zip

# Sync operations
ingest pull reddit    # Y.Doc → SQLite + Markdown
ingest push reddit    # Markdown → Y.Doc

# View stats
ingest stats reddit
```

## Open Questions

1. **ID generation**: Use Reddit's IDs (t3_xxx, t1_xxx) directly, or generate new UUIDs?
   - **Recommendation**: Use Reddit's IDs directly for traceability

2. **Duplicate handling**: What if the same export is imported twice?
   - **Recommendation**: Upsert by ID; newer data wins (LWW)

3. **Platform detection**: Auto-detect platform from ZIP contents?
   - **Recommendation**: Start with explicit `--platform`, add auto-detect later

## References

- [vault-core README](/packages/vault-core/README.md)
- [epicenter README](/packages/epicenter/README.md)
- [epicenter CLI](/packages/epicenter/src/cli/cli.ts)
- [Reddit adapter schema](/packages/vault-core/src/adapters/reddit/src/schema.ts)
