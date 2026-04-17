import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { workspace } from '$lib/client';
import type { DbService } from '$lib/services/db/types';

const MIGRATION_KEY = 'whispering:db-migration';
export type DbMigrationState = 'pending' | 'done';

type MigrationCounts = {
	total: number;
	migrated: number;
	skipped: number;
	failed: number;
};

export type MigrationResult = {
	recordings: MigrationCounts;
	transformations: MigrationCounts;
	steps: MigrationCounts;
};

export const MigrationError = defineErrors({
	WorkspaceNotReady: ({ cause }: { cause: unknown }) => ({
		message: `Workspace failed to initialize: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MigrationError = InferErrors<typeof MigrationError>;

export function getDatabaseMigrationState(): DbMigrationState | null {
	return window.localStorage.getItem(MIGRATION_KEY) as DbMigrationState | null;
}

export function setDatabaseMigrationState(state: DbMigrationState): void {
	window.localStorage.setItem(MIGRATION_KEY, state);
}

export async function probeForOldData(dbService: DbService): Promise<boolean> {
	// Both recordings and transformations have been migrated to workspace.
	// Check runs count as the remaining proxy—if old run data exists in DbService,
	// there may still be data worth migrating.
	const { data: runsCount } = await dbService.runs.getCount();
	return (runsCount ?? 0) > 0;
}

export async function migrateDatabaseToWorkspace({
	_dbService,
	workspace: ws,
	onProgress,
}: {
	dbService: DbService;
	workspace: typeof workspace;
	onProgress: (message: string) => void;
}): Promise<Result<MigrationResult, MigrationError>> {
	const result: MigrationResult = {
		recordings: { total: 0, migrated: 0, skipped: 0, failed: 0 },
		transformations: { total: 0, migrated: 0, skipped: 0, failed: 0 },
		steps: { total: 0, migrated: 0, skipped: 0, failed: 0 },
	};

	const { error: readyError } = await tryAsync({
		try: () => ws.whenReady,
		catch: (cause) => {
			onProgress(`Workspace not ready: ${extractErrorMessage(cause)}`);
			return MigrationError.WorkspaceNotReady({ cause });
		},
	});

	if (readyError) return Err(readyError);

	// Recording migration: skipped (workspace is source of truth, audio-only in DbService).
	// Transformation migration: skipped (workspace-backed since PR #1679).
	onProgress('Skipping recording and transformation migration (workspace is source of truth).');

	return Ok(result);
}
