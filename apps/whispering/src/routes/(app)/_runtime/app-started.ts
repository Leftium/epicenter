/**
 * Owns the once-per-session app-started analytics event.
 */

import { analytics } from '$lib/operations/analytics';

export const appStartedRuntime = {
	attach() {
		analytics.logEvent({ type: 'app_started' });
	},
};
