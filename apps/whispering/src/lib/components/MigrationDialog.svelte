<script module lang="ts">
	import { nanoid } from 'nanoid/non-secure';
	import { Ok, tryAsync } from 'wellcrafted/result';
	import {
		DbServiceLive,
		generateDefaultTransformation,
		type Recording,
	} from '$lib/services/db';
	import { createDbServiceWeb } from '$lib/services/db/web';
	import { DownloadServiceLive } from '$lib/services/download';
	import {
		getDatabaseMigrationState,
		type MigrationResult,
		migrateDatabaseToWorkspace,
		setDatabaseMigrationState,
	} from '$lib/state/migrate-database';
	import workspace from '$lib/workspace';

	const MOCK_RECORDING_COUNT = 10;
	const MOCK_TRANSFORMATION_COUNT = 10;

	const testData = createMigrationTestData();
	const migrationDialog = createMigrationDialog();

	export { migrationDialog };

	function createMigrationTestData() {
		const indexedDb = createDbServiceWeb({
			DownloadService: DownloadServiceLive,
		});

		function createMockRecording(index: number): {
			recording: Recording;
			audio: Blob;
		} {
			const id = nanoid();
			const now = new Date().toISOString();
			const statuses = ['DONE', 'UNPROCESSED', 'FAILED'] as const;
			const transcriptionStatus = statuses[index % statuses.length] ?? 'DONE';

			const recording: Recording = {
				id,
				title: `Mock Recording ${index + 1}`,
				subtitle: 'Generated for workspace migration testing',
				timestamp: now,
				createdAt: now,
				updatedAt: now,
				transcribedText: `Mock transcript ${index + 1}`,
				transcriptionStatus,
			};

			const audio = new Blob([`mock-audio-${index}`], { type: 'audio/webm' });

			return { recording, audio };
		}

		return {
			async seedIndexedDB({
				recordingCount,
				transformationCount,
				onProgress,
			}: {
				recordingCount: number;
				transformationCount: number;
				onProgress: (message: string) => void;
			}): Promise<{ recordings: number; transformations: number }> {
				onProgress(
					`Seeding IndexedDB with ${recordingCount} recordings and ${transformationCount} transformations...`,
				);

				const recordings = Array.from({ length: recordingCount }, (_, index) =>
					createMockRecording(index),
				);

				const { error: recordingsError } =
					await indexedDb.recordings.create(recordings);
				if (recordingsError) {
					throw new Error(
						`Failed to seed recordings: ${recordingsError.message}`,
					);
				}

				const transformations = Array.from(
					{ length: transformationCount },
					(_, index) => {
						const transformation = generateDefaultTransformation();
						transformation.title = `Mock Transformation ${index + 1}`;
						transformation.description =
							'Generated for workspace migration testing';
						return transformation;
					},
				);

				const { error: transformationsError } =
					await indexedDb.transformations.create(transformations);
				if (transformationsError) {
					throw new Error(
						`Failed to seed transformations: ${transformationsError.message}`,
					);
				}

				onProgress(
					`✅ Seed complete: ${recordings.length} recordings, ${transformations.length} transformations`,
				);

				return {
					recordings: recordings.length,
					transformations: transformations.length,
				};
			},

			async clearIndexedDB({
				onProgress,
			}: {
				onProgress: (message: string) => void;
			}): Promise<void> {
				onProgress(
					'Clearing IndexedDB recordings, transformations, and runs...',
				);

				const [recordingsResult, transformationsResult, runsResult] =
					await Promise.all([
						indexedDb.recordings.clear(),
						indexedDb.transformations.clear(),
						indexedDb.runs.clear(),
					]);

				if (recordingsResult.error) {
					throw new Error(
						`Failed to clear recordings: ${recordingsResult.error.message}`,
					);
				}

				if (transformationsResult.error) {
					throw new Error(
						`Failed to clear transformations: ${transformationsResult.error.message}`,
					);
				}

				if (runsResult.error) {
					throw new Error(`Failed to clear runs: ${runsResult.error.message}`);
				}

				onProgress('✅ IndexedDB cleared');
			},
		};
	}

	function createMigrationDialog() {
		let isOpen = $state(false);
		let isRunning = $state(false);
		let isPending = $state(getDatabaseMigrationState() === 'pending');
		let isSeeding = $state(false);
		let isClearing = $state(false);
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

				const { data: result, error: migrationError } =
					await migrateDatabaseToWorkspace({
						dbService: DbServiceLive,
						workspace,
						onProgress: addLog,
					});

				if (migrationError) {
					addLog(`❌ ${migrationError.message}`);
					addLog('Migration state remains pending — you can retry.');
				} else {
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
		};
	}
</script>

<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import type { Snippet } from 'svelte';

	type TriggerProps = {
		props: Record<string, unknown>;
	};

	let { trigger }: { trigger?: Snippet<[TriggerProps]> } = $props();

	let logsContainer = $state<HTMLDivElement | null>(null);

	// Auto-scroll logs to bottom
	$effect(() => {
		if (logsContainer && migrationDialog.logs.length > 0) {
			logsContainer.scrollTop = logsContainer.scrollHeight;
		}
	});
</script>

<Dialog.Root bind:open={migrationDialog.isOpen}>
	{#if trigger}
		<Dialog.Trigger>
			{#snippet child({ props })}
				{@render trigger({ props })}
			{/snippet}
		</Dialog.Trigger>
	{/if}
	<Dialog.Content class="max-h-[90vh] max-w-2xl overflow-y-auto">
		<Dialog.Header>
			<Dialog.Title>Database Migration</Dialog.Title>
			<Dialog.Description>
				Migrate your recordings and transformations to the new workspace format.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4">
			{#if migrationDialog.isPending}
				<Button
					onclick={migrationDialog.startWorkspaceMigration}
					disabled={migrationDialog.isRunning}
					class="w-full"
				>
					{migrationDialog.isRunning ? 'Migrating…' : 'Start Migration'}
				</Button>
			{:else}
				<p class="text-sm text-muted-foreground">
					Migration is already complete.
				</p>
			{/if}

			{#if migrationDialog.logs.length > 0}
				<div class="space-y-2">
					<h3 class="text-sm font-semibold">Progress</h3>
					<div
						bind:this={logsContainer}
						class="max-h-48 overflow-y-auto rounded-lg border bg-muted p-3 font-mono text-xs"
					>
						{#each migrationDialog.logs as log}
							<div class="mb-1">{log}</div>
						{/each}
					</div>
				</div>
			{/if}

			{#if migrationDialog.migrationResult}
				{@const r = migrationDialog.migrationResult}
				<div class="rounded-lg border p-4">
					<h3 class="mb-3 text-sm font-semibold">Results</h3>
					<div class="space-y-1 text-sm text-muted-foreground">
						<p>
							Recordings: {r.recordings.migrated} migrated,
							{r.recordings.skipped}
							skipped, {r.recordings.failed} failed (of {r.recordings.total})
						</p>
						<p>
							Transformations: {r.transformations.migrated} migrated,
							{r.transformations.skipped}
							skipped, {r.transformations.failed}
							failed (of {r.transformations.total})
						</p>
						<p>
							Steps: {r.steps.migrated} migrated, {r.steps.skipped} skipped,
							{r.steps.failed}
							failed (of {r.steps.total})
						</p>
					</div>
				</div>
			{/if}

			{#if import.meta.env.DEV}
				<div class="rounded-lg border border-dashed p-4">
					<h3 class="mb-3 text-sm font-semibold">Dev Tools</h3>
					<div class="flex gap-2">
						<Button
							onclick={migrationDialog.seedIndexedDB}
							disabled={migrationDialog.isSeeding || migrationDialog.isClearing}
							variant="outline"
							size="sm"
						>
							{migrationDialog.isSeeding
								? 'Seeding…'
								: `Seed ${MOCK_RECORDING_COUNT} Recordings`}
						</Button>
						<Button
							onclick={migrationDialog.clearIndexedDB}
							disabled={migrationDialog.isSeeding || migrationDialog.isClearing}
							variant="outline"
							size="sm"
						>
							{migrationDialog.isClearing ? 'Clearing…' : 'Clear IndexedDB'}
						</Button>
					</div>
				</div>
			{/if}
		</div>

		<Dialog.Footer>
			<Button
				onclick={() => (migrationDialog.isOpen = false)}
				variant="outline"
			>
				Close
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
