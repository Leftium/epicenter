import { tauri } from '#platform/tauri';
import {
	TRANSCRIPTION_PROVIDERS,
	type TranscriptionProviderEntry,
} from '$lib/services/transcription/provider-ui';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';

/**
 * Gets the currently selected transcription service.
 * Returns undefined if the service is not available on this platform.
 *
 * @returns The selected transcription service, or undefined if none selected or invalid
 */
export function getSelectedTranscriptionService():
	| TranscriptionProviderEntry
	| undefined {
	const selectedServiceId = settings.get('transcription.service');
	const service = TRANSCRIPTION_PROVIDERS.find(
		(s) => s.id === selectedServiceId,
	);
	if (!tauri && service?.location === 'local') return undefined;
	return service;
}

/**
 * Checks if a transcription service has all required configuration. The
 * required key is the provider's own config key (apiKey / endpoint / model),
 * read straight from its registry entry.
 *
 * @param service - The transcription service to check
 * @returns true if the service is properly configured, false otherwise
 */
export function isTranscriptionServiceConfigured(
	service: TranscriptionProviderEntry,
): boolean {
	switch (service.location) {
		case 'cloud':
			return deviceConfig.get(service.apiKeyKey) !== '';
		case 'self-hosted':
			return deviceConfig.get(service.endpointKey) !== '';
		case 'local':
			return deviceConfig.get(service.modelKey) !== '';
	}
}
