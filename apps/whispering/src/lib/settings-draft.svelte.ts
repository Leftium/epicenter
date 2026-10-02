/**
 * The one draft of the transcription settings: the endpoint and model, which
 * are folder settings in `kv.json`, and a newly typed API key, which stays on
 * this device.
 *
 * The session owns it, so the form is the same draft wherever it is shown:
 * what was typed in the header's Settings is what the form beside the
 * recorder shows, and there is one save and one typed key.
 *
 * The endpoint and model follow the saved settings until they are typed in,
 * and follow them again when the saved settings change. The key is never
 * read back: the draft holds only what was typed since the last save.
 */
import type { Library } from './library.svelte.js';

export type SettingsDraft = ReturnType<typeof createSettingsDraft>;

/** Why a save did not finish, as a heading and the reason. */
export type SettingsSaveProblem = {
	readonly title: string;
	readonly description: string;
};

export function createSettingsDraft(library: Library) {
	let baseUrl = $derived(library.settings.transcriptionBaseUrl);
	let model = $derived(library.settings.transcriptionModel);
	let apiKey = $state('');
	let saving = $state(false);

	return {
		get baseUrl() {
			return baseUrl;
		},
		set baseUrl(value: string) {
			baseUrl = value;
		},
		get model() {
			return model;
		},
		set model(value: string) {
			model = value;
		},
		get apiKey() {
			return apiKey;
		},
		set apiKey(value: string) {
			apiKey = value;
		},
		get saving() {
			return saving;
		},
		/**
		 * Save the endpoint and model to the folder, then a typed key to this
		 * device. An empty key field keeps the current key. Nothing is sent to
		 * the endpoint.
		 */
		async save(): Promise<SettingsSaveProblem | undefined> {
			if (saving) return undefined;
			saving = true;
			try {
				const problem = await library.saveSettings({
					transcriptionBaseUrl: baseUrl.trim(),
					transcriptionModel: model.trim(),
				});
				if (problem)
					return { title: 'Could not save the settings', description: problem };
				if (apiKey !== '') {
					const keyProblem = await library.saveCredential(apiKey);
					if (keyProblem)
						return { title: 'Could not save the key', description: keyProblem };
					apiKey = '';
				}
				return undefined;
			} finally {
				saving = false;
			}
		},
	};
}
