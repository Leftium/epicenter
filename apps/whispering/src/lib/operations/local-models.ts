/**
 * Lifecycle orchestration for one pre-built local transcription model:
 * combines its catalog storage handle with the engine's model setting in
 * `deviceConfig` (the key comes from the provider registry). A model is
 * "active" when that setting holds its folder entry name.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type LocalModelConfig,
	modelEntryName,
} from '$lib/constants/local-models';
import {
	createModelStorage,
	type LocalModelFolderError,
} from '$lib/services/transcription/local-model-folder';
import { PROVIDERS } from '$lib/services/transcription/providers';
import { deviceConfig } from '$lib/state/device-config.svelte';

/**
 * Per-model handle the settings UI drives. Stateless; safe to recreate
 * freely (the download card derives one from its `model` prop).
 */
export function createPrebuiltModel(model: LocalModelConfig) {
	const storage = createModelStorage(model);
	const settingsKey = PROVIDERS[model.engine].modelKey;
	const entryName = modelEntryName(model);

	return {
		/**
		 * The engine's currently selected model name. Reads `deviceConfig`,
		 * so reading it inside `$effect` or `$derived` tracks changes.
		 */
		get activeModelName() {
			return deviceConfig.get(settingsKey);
		},

		/**
		 * Where the model stands on this device: missing or corrupted
		 * (`not-downloaded`), installed (`ready`), or installed and selected
		 * as the engine's model (`active`). Never rejects.
		 */
		async getStatus(): Promise<'not-downloaded' | 'ready' | 'active'> {
			const installedPath = await storage.getInstalledPath();
			if (!installedPath) return 'not-downloaded';
			return deviceConfig.get(settingsKey) === entryName ? 'active' : 'ready';
		},

		/** Point the engine's model setting at this model's entry name. */
		activate(): void {
			deviceConfig.set(settingsKey, entryName);
		},

		/**
		 * Download the model (skipping the download when a valid install
		 * already exists) and activate it. The `outcome` tells callers which
		 * happened so they can phrase confirmation accordingly.
		 */
		async downloadAndActivate({
			onProgress,
		}: {
			onProgress: (progress: number) => void;
		}): Promise<
			Result<
				{ outcome: 'downloaded' | 'already-installed' },
				LocalModelFolderError
			>
		> {
			const installedPath = await storage.getInstalledPath();
			if (installedPath) {
				deviceConfig.set(settingsKey, entryName);
				return Ok({ outcome: 'already-installed' });
			}

			const { error: downloadError } = await storage.download({ onProgress });
			if (downloadError) return Err(downloadError);

			deviceConfig.set(settingsKey, entryName);
			return Ok({ outcome: 'downloaded' });
		},

		/**
		 * Remove the model from disk and, when it was the engine's active
		 * model, clear the engine's model setting.
		 */
		async delete(): Promise<Result<void, LocalModelFolderError>> {
			const { error: deleteError } = await storage.delete();
			if (deleteError) return Err(deleteError);

			if (deviceConfig.get(settingsKey) === entryName) {
				deviceConfig.set(settingsKey, '');
			}
			return Ok(undefined);
		},
	};
}
