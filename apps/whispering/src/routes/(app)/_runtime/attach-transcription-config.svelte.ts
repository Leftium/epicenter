import { tauri } from '#platform/tauri';
import {
	isLocalProviderId,
	PROVIDERS,
} from '$lib/services/transcription/providers';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';
import { commands } from '$lib/tauri/commands';

export function attachTranscriptionConfig() {
	$effect(() => {
		if (!tauri) return;
		const service = settings.get('transcription.service');
		if (!isLocalProviderId(service)) return;

		const modelName = deviceConfig.get(PROVIDERS[service].modelConfigKey);
		if (!modelName) return;

		const language = settings.get('transcription.language');
		const prompt = settings.get('transcription.prompt');
		void commands
			.setTranscriptionConfig({
				engine: service,
				modelName,
				language: language === 'auto' ? null : language,
				initialPrompt: prompt || null,
				unloadPolicy: deviceConfig.get('transcription.localModelUnloadPolicy'),
			})
			.catch((err) => {
				console.error('Failed to push transcription config to Rust:', err);
			});
	});

	return () => {};
}
