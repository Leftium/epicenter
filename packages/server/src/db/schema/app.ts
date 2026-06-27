import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Per-row partition key. Equals the signed-in user's id in personal mode and
 * the literal `INSTANCE_OWNER_ID` (`'instance'`) on an instance. No foreign key
 * to `user.id`: on an instance `owner_id` is not a user, so the FK would fail.
 * Account-delete cleanup runs in the auth `before(delete)` hook and naturally
 * no-ops on an instance (`owner_id !== user.id`).
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
