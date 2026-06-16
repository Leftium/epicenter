import { analytics } from '$lib/operations/analytics';

export function attachAnalytics() {
	$effect(() => {
		analytics.logEvent({ type: 'app_started' });
	});

	return () => {};
}
