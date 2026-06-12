/**
 * Shared download state for pre-built local transcription models, keyed by
 * model id. Every surface that renders a model (recommended-model hero,
 * catalog row) reads the same handle, so a download started in one place
 * shows its progress everywhere.
 *
 * The state machine is computed, not stored: `downloading` while a download
 * owns the handle, otherwise disk truth (`isInstalled`) plus the engine's
 * reactive model setting decide between not-downloaded, ready, and active.
 * The models folder is user-editable truth (entries can be dropped in or
 * deleted outside the app), so `refresh()` re-checks disk; the selector
 * calls it from the same window-focus rescan that refreshes folder entries.
 *
 * Shape mirrors `local-model.svelte.ts`: factory function with `$state`
 * closure variables and a return object exposing a reactive getter plus
 * operations.
 */
import { toast } from '@epicenter/ui/sonner';
import {
	type LocalModelConfig,
	modelEntryName,
} from '$lib/constants/local-models';
import { createPrebuiltModel } from '$lib/operations/local-models';
import { createModelStorage } from '$lib/services/transcription/local-model-folder';

export type ModelDownloadState =
	| { type: 'not-downloaded' }
	| { type: 'downloading'; progress: number }
	| { type: 'ready' }
	| { type: 'active' };

function createModelDownload(model: LocalModelConfig) {
	const storage = createModelStorage(model);
	const prebuiltModel = createPrebuiltModel(model);
	const entryName = modelEntryName(model);

	/** Disk truth: whether a valid install exists in the models folder. */
	let isInstalled = $state(false);

	/** Progress 0-100 while this handle owns a download, else null. */
	let progress = $state<number | null>(null);

	async function refresh() {
		isInstalled = (await storage.getInstalledPath()) !== null;
	}

	void refresh();

	return {
		/**
		 * Where this model stands on this device. A getter, not a `$derived`:
		 * handles are created lazily from whichever component touches them
		 * first, and a derived created inside a component's effect context
		 * goes inert when that component is destroyed (`derived_inert`). The
		 * computation is two comparisons; consumers that need caching or
		 * narrowing alias it with a component-local `$derived`.
		 */
		get state(): ModelDownloadState {
			if (progress !== null) return { type: 'downloading', progress };
			if (!isInstalled) return { type: 'not-downloaded' };
			return prebuiltModel.activeModelName === entryName
				? { type: 'active' }
				: { type: 'ready' };
		},

		/**
		 * Re-check disk truth. The models folder can change outside the app
		 * (entries deleted, a partial download cleaned up), so callers invoke
		 * this on the same signal they use to rescan the folder, typically
		 * window focus.
		 */
		refresh,

		/**
		 * Download the model (skipping the download when a valid install
		 * already exists) and activate it.
		 */
		async download() {
			if (progress !== null) return;
			progress = 0;

			const { data, error } = await prebuiltModel.downloadAndActivate({
				onProgress: (value) => {
					progress = value;
				},
			});
			if (error) {
				progress = null;
				toast.error('Failed to download model', {
					description: error.message,
				});
				return;
			}

			// Refresh disk truth before releasing the downloading state so the
			// computed machine lands directly on active.
			await refresh();
			progress = null;
			toast.success(
				data.outcome === 'already-installed'
					? 'Model already downloaded and activated'
					: 'Model downloaded and activated successfully',
			);
		},

		/** Point the engine's model setting at this model's entry name. */
		activate() {
			prebuiltModel.activate();
			toast.success('Model activated');
		},

		/**
		 * Remove the model from disk and, when it was the engine's active
		 * model, clear the engine's model setting.
		 */
		async delete() {
			const { error } = await prebuiltModel.delete();
			if (error) {
				toast.error('Failed to delete model', {
					description: error.message,
				});
				return;
			}
			isInstalled = false;
			toast.success('Model deleted');
		},
	};
}

function createLocalModelDownloads() {
	const handles = new Map<string, ReturnType<typeof createModelDownload>>();

	return {
		/** The shared download handle for a catalog model, created on first use. */
		get(model: LocalModelConfig) {
			const existing = handles.get(model.id);
			if (existing) return existing;
			const handle = createModelDownload(model);
			handles.set(model.id, handle);
			return handle;
		},
	};
}

export const localModelDownloads = createLocalModelDownloads();
