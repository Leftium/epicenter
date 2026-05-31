import { goto } from '$app/navigation';
import { report } from '$lib/report';
import {
	getSelectedTranscriptionService,
	isTranscriptionServiceConfigured,
} from '$lib/settings/transcription-validation';

/**
 * Checks if the user has configured the necessary API keys/settings for their selected transcription service.
 * Shows an onboarding toast if configuration is missing.
 */
export function registerOnboarding() {
	const selectedService = getSelectedTranscriptionService();

	// Check transcription service configuration
	if (!selectedService) {
		report.info({
			title: 'Welcome to Whispering!',
			description: 'Please select a transcription service to get started.',
			action: {
				label: 'Configure',
				onClick: () => goto('/settings/transcription'),
			},
		});
		return;
	}

	if (!isTranscriptionServiceConfigured(selectedService)) {
		const missingConfig = (
			{
				cloud: `${selectedService.label} API key`,
				'self-hosted': `${selectedService.label} server URL`,
				local: `${selectedService.label} model file`,
			} as const
		)[selectedService.location];

		report.info({
			title: 'Welcome to Whispering!',
			description: `Please configure your ${missingConfig} to get started.`,
			action: {
				label: 'Configure',
				onClick: () => goto('/settings/transcription'),
			},
		});
	}
}
