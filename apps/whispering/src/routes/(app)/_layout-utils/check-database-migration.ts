import { migrationDialog } from '$lib/migration/migration-dialog.svelte';

/**
 * Check whether the user has old data that should be migrated to workspace tables.
 * Thin wrapper—all logic lives in {@link migrationDialog.check}.
 */
export async function checkDatabaseMigration(): Promise<void> {
	return migrationDialog.check();
}
