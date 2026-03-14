import { Ok, tryAsync, trySync } from 'wellcrafted/result';
import type { DbService } from '$lib/services/db/types';
import type workspace from '$lib/workspace';

const MIGRATION_KEY = 'whispering:db-migration';
type DbMigrationState = 'pending' | 'done';

type WorkspaceRecordingRow = Parameters<
	(typeof workspace.tables.recordings)['set']
>[0];
type WorkspaceTransformationRow = Parameters<
	(typeof workspace.tables.transformations)['set']
>[0];
type WorkspaceTransformationStepRow = Parameters<
	(typeof workspace.tables.transformationSteps)['set']
>[0];

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

export function getDatabaseMigrationState(): DbMigrationState | null {
	return window.localStorage.getItem(MIGRATION_KEY) as DbMigrationState | null;
}

export function setDatabaseMigrationState(state: DbMigrationState): void {
	window.localStorage.setItem(MIGRATION_KEY, state);
}

export async function probeForOldData(dbService: DbService): Promise<boolean> {
	const { data: recordingsCount } = await dbService.recordings.getCount();
	const { data: transformationsCount } =
		await dbService.transformations.getCount();

	return (recordingsCount ?? 0) > 0 || (transformationsCount ?? 0) > 0;
}

export async function migrateDatabaseToWorkspace({
	dbService,
	workspace: ws,
	onProgress,
}: {
	dbService: DbService;
	workspace: typeof workspace;
	onProgress: (message: string) => void;
}): Promise<MigrationResult> {
	const result: MigrationResult = {
		recordings: { total: 0, migrated: 0, skipped: 0, failed: 0 },
		transformations: { total: 0, migrated: 0, skipped: 0, failed: 0 },
		steps: { total: 0, migrated: 0, skipped: 0, failed: 0 },
	};

	const { error: readyError } = await tryAsync({
		try: () => ws.whenReady,
		catch: (cause) => {
			onProgress(`workspace.whenReady failed: ${String(cause)}`);
			return Ok(undefined);
		},
	});

	if (readyError) {
		return result;
	}

	const recordingsResult = await dbService.recordings.getAll();
	const transformationsResult = await dbService.transformations.getAll();

	const recordings = recordingsResult.data ?? [];
	const transformations = transformationsResult.data ?? [];

	result.recordings.total = recordings.length;
	result.transformations.total = transformations.length;
	result.steps.total = transformations.reduce((count, transformation) => {
		return count + transformation.steps.length;
	}, 0);

	onProgress(`Migrating ${recordings.length} recordings...`);
	const batchSize = 100;

	for (let start = 0; start < recordings.length; start += batchSize) {
		const batch = recordings.slice(start, start + batchSize);
		const batchNum = Math.floor(start / batchSize) + 1;
		const totalBatches = Math.ceil(recordings.length / batchSize);
		onProgress(`Recordings batch ${batchNum}/${totalBatches}...`);

		for (const recording of batch) {
			trySync({
				try: () => {
					if (ws.tables.recordings.get(recording.id)) {
						result.recordings.skipped += 1;
						return;
					}

					const row: WorkspaceRecordingRow = {
						...recording,
						transcriptionStatus:
							recording.transcriptionStatus === 'TRANSCRIBING'
								? 'FAILED'
								: recording.transcriptionStatus,
						_v: 1 as const,
					};

					ws.tables.recordings.set(row);
					result.recordings.migrated += 1;
				},
				catch: (cause) => {
					result.recordings.failed += 1;
					onProgress(`Failed recording ${recording.id}: ${String(cause)}`);
					return Ok(undefined);
				},
			});
		}
	}

	onProgress(`Recordings done: ${result.recordings.migrated} migrated, ${result.recordings.skipped} skipped, ${result.recordings.failed} failed`);

	onProgress(`Migrating ${transformations.length} transformations (${result.steps.total} steps)...`);

	for (const transformation of transformations) {
		trySync({
			try: () => {
				if (ws.tables.transformations.get(transformation.id)) {
					result.transformations.skipped += 1;
					return;
				}

				const row: WorkspaceTransformationRow = {
					id: transformation.id,
					title: transformation.title,
					description: transformation.description,
					createdAt: transformation.createdAt,
					updatedAt: transformation.updatedAt,
					_v: 1 as const,
				};

				ws.tables.transformations.set(row);
				result.transformations.migrated += 1;
			},
			catch: (cause) => {
				result.transformations.failed += 1;
				onProgress(
					`Failed transformation ${transformation.id}: ${String(cause)}`,
				);
				return Ok(undefined);
			},
		});

		for (let index = 0; index < transformation.steps.length; index += 1) {
			const step = transformation.steps[index]!;

			trySync({
				try: () => {
					if (ws.tables.transformationSteps.get(step.id)) {
						result.steps.skipped += 1;
						return;
					}

					const row: WorkspaceTransformationStepRow = {
						id: step.id,
						transformationId: transformation.id,
						order: index,
						type: step.type,
						inferenceProvider: step['prompt_transform.inference.provider'],
						openaiModel:
							step['prompt_transform.inference.provider.OpenAI.model'],
						groqModel: step['prompt_transform.inference.provider.Groq.model'],
						anthropicModel:
							step['prompt_transform.inference.provider.Anthropic.model'],
						googleModel:
							step['prompt_transform.inference.provider.Google.model'],
						openrouterModel:
							step['prompt_transform.inference.provider.OpenRouter.model'],
						customModel:
							step['prompt_transform.inference.provider.Custom.model'],
						customBaseUrl:
							step['prompt_transform.inference.provider.Custom.baseUrl'],
						systemPromptTemplate: step['prompt_transform.systemPromptTemplate'],
						userPromptTemplate: step['prompt_transform.userPromptTemplate'],
						findText: step['find_replace.findText'],
						replaceText: step['find_replace.replaceText'],
						useRegex: step['find_replace.useRegex'],
						_v: 1 as const,
					};

					ws.tables.transformationSteps.set(row);
					result.steps.migrated += 1;
				},
				catch: (cause) => {
					result.steps.failed += 1;
					onProgress(
						`Failed step ${step.id} in transformation ${transformation.id}: ${String(cause)}`,
					);
					return Ok(undefined);
				},
			});
		}
	}

	onProgress(`Transformations done: ${result.transformations.migrated} migrated, ${result.transformations.skipped} skipped, ${result.transformations.failed} failed`);
	onProgress(`Steps done: ${result.steps.migrated} migrated, ${result.steps.skipped} skipped, ${result.steps.failed} failed`);

	return result;
}
