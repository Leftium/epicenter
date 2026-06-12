/**
 * Lifecycle orchestration for one pre-built local transcription model:
 * combines its on-disk storage handle with the engine's model path setting
 * in `deviceConfig` (the key comes from the provider registry). A model is
 * "active" when that setting points at its canonical install path.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { LocalModelConfig } from '$lib/constants/local-models';
import {
	createModelStorage,
	type LocalModelStorageError,
} from '$lib/services/transcription/local-model-storage';
import { PROVIDERS } from '$lib/services/transcription/providers';
import { deviceConfig } from '$lib/state/device-config.svelte';

/**
 * Per-model handle the settings UI drives. Stateless; safe to recreate
 * freely (the download card derives one from its `model` prop).
 */
export function createPrebuiltModel(model: LocalModelConfig) {
	const storage = createModelStorage(model);
	const settingsKey = PROVIDERS[model.engine].modelPathKey;

	return {
		/**
		 * The engine's currently selected model path. Reads `deviceConfig`,
		 * so reading it inside `$effect` or `$derived` tracks changes.
		 */
		get activeModelPath() {
			return deviceConfig.get(settingsKey);
		},

		/**
		 * Where the model stands on this device: missing or corrupted
		 * (`not-downloaded`), installed (`ready`), or installed and selected
		 * as the engine's model path (`active`). Never rejects.
		 */
		async getStatus(): Promise<'not-downloaded' | 'ready' | 'active'> {
			const installedPath = await storage.getInstalledPath();
			if (!installedPath) return 'not-downloaded';
			const isActive = deviceConfig.get(settingsKey) === installedPath;
			return isActive ? 'active' : 'ready';
		},

		/**
		 * Point the engine's model path setting at this model's canonical
		 * install path.
		 */
		async activate(): Promise<void> {
			deviceConfig.set(settingsKey, await storage.getPath());
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
				LocalModelStorageError
			>
		> {
			const installedPath = await storage.getInstalledPath();
			if (installedPath) {
				deviceConfig.set(settingsKey, installedPath);
				return Ok({ outcome: 'already-installed' });
			}

			const { data, error: downloadError } = await storage.download({
				onProgress,
			});
			if (downloadError) return Err(downloadError);

			deviceConfig.set(settingsKey, data.path);
			return Ok({ outcome: 'downloaded' });
		},

		/**
		 * Remove the model from disk and, when it was the engine's active
		 * model, clear the engine's model path setting.
		 */
		async delete(): Promise<Result<void, LocalModelStorageError>> {
			const { data, error: deleteError } = await storage.delete();
			if (deleteError) return Err(deleteError);

			if (deviceConfig.get(settingsKey) === data.path) {
				deviceConfig.set(settingsKey, '');
			}
			return Ok(undefined);
		},
	};
}
