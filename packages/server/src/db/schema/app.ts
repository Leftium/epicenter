import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Per-row partition key. Equals the signed-in user's id in personal mode and
 * the literal `SHARED_OWNER_ID` (`'shared'`) in shared mode. No foreign key to
 * `user.id`: in shared mode `owner_id` is not a user, so the FK would fail.
 * Account-delete cleanup runs in the auth `before(delete)` hook and naturally
 * no-ops in shared mode (`owner_id !== user.id`).
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
