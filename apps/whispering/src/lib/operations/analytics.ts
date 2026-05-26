import { services } from '$lib/services';
import type { Event } from '$lib/services/analytics/types';
import { settings } from '$lib/state/settings.svelte';

/**
 * Log an anonymous analytics event if analytics is enabled in settings.
 */
export const analytics = {
	logEvent: async (event: Event) => {
		if (!settings.get('analytics.enabled')) return;
		await services.analytics.logEvent(event);
	},
};
