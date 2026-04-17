import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import type { workspace } from '$lib/client';
import type { DbService } from '$lib/services/db/types';

const MIGRATION_KEY = 'whispering:db-migration';
export type DbMigrationState = 'pending' | 'done';

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
	// Recording metadata is no longer available through DbService (audio-only now).
	// Transformations count is a sufficient proxy—if any old data exists,
	// transformations are almost always present alongside recordings.
	const { data: transformationsCount } =
		await dbService.transformations.getCount();

	return (transformationsCount ?? 0) > 0;
}

export async function migrateDatabaseToWorkspace({
	dbService,
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

	// Recording migration is no longer needed here.
	// Recording metadata now lives exclusively in the workspace (Yjs CRDT).
	// Audio blobs remain accessible through the audio-only DbService.
	// Desktop users: the materializer syncs workspace ↔ .md files on disk.
	// Web users: recording metadata was migrated during earlier app versions.
	onProgress('Skipping recording migration (workspace is source of truth).');

	const transformationsResult = await dbService.transformations.getAll();
	const transformations = transformationsResult.data ?? [];

	result.transformations.total = transformations.length;
	result.steps.total = transformations.reduce((count, transformation) => {
		return count + transformation.steps.length;
	}, 0);

	onProgress(
		`Migrating ${transformations.length} transformations (${result.steps.total} steps)...`,
	);

	for (const transformation of transformations) {
		trySync({
			try: () => {
				if (ws.tables.transformations.has(transformation.id)) {
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
			const step = transformation.steps[index];
			if (!step) continue;

			trySync({
				try: () => {
					if (ws.tables.transformationSteps.has(step.id)) {
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

	onProgress(
		`Transformations done: ${result.transformations.migrated} migrated, ${result.transformations.skipped} skipped, ${result.transformations.failed} failed`,
	);
	onProgress(
		`Steps done: ${result.steps.migrated} migrated, ${result.steps.skipped} skipped, ${result.steps.failed} failed`,
	);

	return Ok(result);
}
