import { Ok, tryAsync } from 'wellcrafted/result';
import { DbServiceLive } from '$lib/services/db';
import workspace from '$lib/workspace';
import {
	getDatabaseMigrationState,
	type MigrationResult,
	migrateDatabaseToWorkspace,
	setDatabaseMigrationState,
} from './migrate-database';
import {
	createMigrationTestData,
	MOCK_RECORDING_COUNT,
	MOCK_TRANSFORMATION_COUNT,
} from './migration-test-data';

const testData = createMigrationTestData();

function createMigrationDialog() {
	let isOpen = $state(false);
	let isRunning = $state(false);
	let isPending = $state(getDatabaseMigrationState() === 'pending');
	let isSeeding = $state(false);
	let isClearing = $state(false);
	let isResetting = $state(false);
	let logs = $state<string[]>([]);
	let migrationResult = $state<MigrationResult | null>(null);

	function addLog(message: string) {
		logs.push(message);
	}

	return {
		get isOpen() {
			return isOpen;
		},
		set isOpen(value: boolean) {
			isOpen = value;
		},
		openDialog() {
			if (typeof window !== 'undefined') {
				isPending = getDatabaseMigrationState() === 'pending';
			}
			isOpen = true;
		},
		get isRunning() {
			return isRunning;
		},
		get logs() {
			return logs;
		},
		get migrationResult() {
			return migrationResult;
		},
		async startWorkspaceMigration() {
			if (isRunning) return;

			isRunning = true;
			logs = [];
			migrationResult = null;
			addLog('Starting workspace migration...');

			const { data: migrationOutcome } = await tryAsync({
				try: () =>
					migrateDatabaseToWorkspace({
						dbService: DbServiceLive,
						workspace,
						onProgress: addLog,
					}),
				catch: (error) => {
					addLog(
						`❌ Migration failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					addLog('Migration state remains pending — you can retry.');
					return Ok(null);
				},
			});

			if (migrationOutcome?.error) {
				addLog(`❌ Migration failed: ${migrationOutcome.error.message}`);
				addLog('Migration state remains pending — you can retry.');
			}

			const result = migrationOutcome?.data ?? null;

			if (result) {
				migrationResult = result;
				setDatabaseMigrationState('done');
				isPending = false;
				addLog('✅ Migration complete');
				addLog(
					`Recordings: ${result.recordings.migrated} migrated, ${result.recordings.skipped} skipped, ${result.recordings.failed} failed`,
				);
				addLog(
					`Transformations: ${result.transformations.migrated} migrated, ${result.transformations.skipped} skipped, ${result.transformations.failed} failed`,
				);
				addLog(
					`Steps: ${result.steps.migrated} migrated, ${result.steps.skipped} skipped, ${result.steps.failed} failed`,
				);
			}

			isRunning = false;
		},
		get isPending() {
			return isPending;
		},
		set isPending(value: boolean) {
			isPending = value;
		},
		get isSeeding() {
			return isSeeding;
		},
		get isClearing() {
			return isClearing;
		},
		get isResetting() {
			return isResetting;
		},
		/** True when any dev tool operation is in progress. */
		get isDevBusy() {
			return isSeeding || isClearing || isResetting;
		},
		async seedIndexedDB() {
			if (isSeeding) return;

			isSeeding = true;
			logs = [];

			await tryAsync({
				try: async () => {
					await testData.seedIndexedDB({
						recordingCount: MOCK_RECORDING_COUNT,
						transformationCount: MOCK_TRANSFORMATION_COUNT,
						onProgress: addLog,
					});
				},
				catch: (error) => {
					addLog(
						`❌ Seeding failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					return Ok(undefined);
				},
			});

			isSeeding = false;
		},
		async clearIndexedDB() {
			if (isClearing) return;

			isClearing = true;
			logs = [];

			await tryAsync({
				try: () => testData.clearIndexedDB({ onProgress: addLog }),
				catch: (error) => {
					addLog(
						`❌ Clear failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					return Ok(undefined);
				},
			});

			isClearing = false;
		},
		async resetMigration() {
			if (isResetting) return;

			isResetting = true;
			logs = [];
			migrationResult = null;

			addLog('Clearing workspace tables...');
			workspace.tables.recordings.clear();
			workspace.tables.transformations.clear();
			workspace.tables.transformationSteps.clear();
			addLog('✅ Workspace tables cleared');

			addLog('Resetting migration state...');
			window.localStorage.removeItem('whispering:db-migration');
			isPending = true;
			addLog('✅ Migration state reset to pending');

			isResetting = false;
		},
	};
}

export const migrationDialog = createMigrationDialog();
