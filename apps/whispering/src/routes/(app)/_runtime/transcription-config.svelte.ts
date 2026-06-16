/**
 * Owns mirroring the ambient local transcription config into the Rust runtime.
 */

import { tauri } from '#platform/tauri';
import { report } from '$lib/report';
import {
	isLocalProviderId,
	PROVIDERS,
} from '$lib/services/transcription/providers';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';
import { commands as tauriCommands } from '$lib/tauri/commands';

export const transcriptionConfigRuntime = {
	attach() {
		$effect(() => {
			if (!tauri) return;
			const service = settings.get('transcription.service');
			if (!isLocalProviderId(service)) return;

			const modelName = deviceConfig.get(PROVIDERS[service].modelConfigKey);
			if (!modelName) return;

			const language = settings.get('transcription.language');
			const prompt = settings.get('transcription.prompt');
			void tauriCommands
				.setTranscriptionConfig({
					engine: service,
					modelName,
					language: language === 'auto' ? null : language,
					initialPrompt: prompt || null,
					unloadPolicy: deviceConfig.get(
						'transcription.localModelUnloadPolicy',
					),
				})
				.catch((cause) => {
					report.error({
						title: 'Failed to push transcription config to Rust',
						cause,
					});
				});
		});
	},
};
