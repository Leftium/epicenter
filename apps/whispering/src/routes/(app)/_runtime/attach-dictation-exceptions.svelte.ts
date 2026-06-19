import type { AnyTaggedError } from 'wellcrafted/error';
import { osNotify } from '#platform/os-notify';
import type { DictationFailureTier } from '$lib/recording-overlay/events';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

/**
 * The exception projection over the dictation lifecycle. The pill is the visible
 * alert and carries Retry, so the only thing this adds is the unfocused case: a
 * red pill in a window the user is not looking at is useless, so a failure also
 * fires the OS notification, the one earned platform conditional (ADR-0029).
 *
 * There is no toast and no `MoreDetailsDialog` here: the pill is the alert and
 * the recordings row is the detail. `report.warning` and standing-condition
 * warnings (revoked Accessibility, dead listener) are a different, present-tense
 * path and are untouched.
 */
const NOTIFICATION_TITLE = {
	'silent-loss': 'Recording failed',
	transcription: 'Transcription failed',
	delivery: 'Delivery failed',
} as const satisfies Record<DictationFailureTier, string>;

export function attachDictationExceptions() {
	// The failure's error object is stable for the life of one failure, so it is
	// the identity that gates "have I already notified for this one". Each new
	// failure mints a new error, so it notifies once.
	let lastNotifiedError: AnyTaggedError | undefined;

	$effect(() => {
		// Read the outcome track directly, never the composed pill value: a VAD
		// utterance fails while the session keeps listening, so a failure must
		// notify even though the live meter is what the pill is showing.
		const { outcome } = dictationLifecycle.current;
		if (outcome.kind !== 'failed') return;
		if (outcome.error === lastNotifiedError) return;
		lastNotifiedError = outcome.error;

		// Delivery failures are quiet: the transcript is in history, so they do not
		// earn an OS notification. The loud tiers do, but only when unfocused: when
		// the window is focused the pill (and the recordings row) already show it.
		if (outcome.tier === 'delivery') return;
		if (document.hasFocus()) return;
		osNotify(NOTIFICATION_TITLE[outcome.tier], outcome.error.message);
	});

	return () => {};
}
