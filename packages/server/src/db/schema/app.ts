import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Per-row partition key. Equals the signed-in user's id in personal mode and
 * the literal `TEAM_OWNER_ID` (`'team'`) in team mode. No foreign key to
 * `user.id`: in team mode `owner_id` is not a user, so the FK would fail.
 * Account-delete cleanup runs in the auth `before(delete)` hook and naturally
 * no-ops in team mode (`owner_id !== user.id`).
 */
export const durableObjectInstance = pgTable(
	'durable_object_instance',
	{
		ownerId: text('owner_id').notNull(),
		resourceName: text('resource_name').notNull(),
		doName: text('do_name').primaryKey(),
		storageBytes: bigint('storage_bytes', { mode: 'number' }),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		lastAccessedAt: timestamp('last_accessed_at').defaultNow().notNull(),
		storageMeasuredAt: timestamp('storage_measured_at'),
	},
	(table) => [index('doi_owner_id_idx').on(table.ownerId)],
);

export const asset = pgTable(
	'asset',
	{
		id: text('id').primaryKey(),
		ownerId: text('owner_id').notNull(),
		contentType: text('content_type').notNull(),
		sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
		originalName: text('original_name').notNull(),
		uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
	},
	(table) => [index('asset_owner_id_idx').on(table.ownerId)],
);
