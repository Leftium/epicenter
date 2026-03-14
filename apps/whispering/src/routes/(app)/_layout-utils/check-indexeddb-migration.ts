import { migrationDialog } from '$lib/components/MigrationDialog.svelte';
import { rpc } from '$lib/query';
import { DbServiceLive } from '$lib/services/db';
import {
	getDatabaseMigrationState,
	probeForOldData,
	setDatabaseMigrationState,
} from '$lib/state/migrate-database';

/**
 * Check whether the user has old data that should be migrated to workspace tables.
 *
 * State machine:
 *   (absent) → probe old data → found? set 'pending' : set 'done'
 *   'pending' → show toast with "Migrate" button
 *   'done'    → skip
 */
export async function checkDatabaseMigration(): Promise<void> {
	const state = getDatabaseMigrationState();

	// Already done — nothing to do
	if (state === 'done') return;

	if (state === null) {
		// First check: probe for old data
		const hasData = await probeForOldData(DbServiceLive);
		if (!hasData) {
			setDatabaseMigrationState('done');
			return;
		}
		setDatabaseMigrationState('pending');
	}

	// State is 'pending' — show toast
	migrationDialog.isPending = true;

	rpc.notify.info({
		title: 'Data Migration Available',
		description:
			'Your recordings and transformations can be migrated to the new workspace storage.',
		action: {
			type: 'button',
			label: 'Migrate Now',
			onClick: () => {
				migrationDialog.isOpen = true;
			},
		},
		persist: true,
	});
}
