import type { AnyTaggedError } from 'wellcrafted/error';
import type { VadState } from '$lib/constants/audio';
import type { DictationFailureTier } from '$lib/recording-overlay/events';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

/**
 * The dictation lifecycle owned by the main window. See ADR-0029.
 *
 * Voice-activated capture is *continuous*: an utterance transcribes while the
 * session keeps listening, so a live meter and a pipeline outcome run at once.
 * Manual capture is sequential. Three facts keep both honest:
 *
 * - `capture` is *derived* from the recorder machines: the live session, with no
 *   second copy of "are we recording" to drift.
 * - `outcome` is the most-recent utterance's pipeline result, an ephemeral signal
 *   the pipeline drives. Most-recent-wins: the OS-notification path reads it and
 *   wants each distinct failure exactly once, so a new utterance overwrites it.
 * - `unreviewedFailure` is a VAD-only latch. Because `outcome` is overwritten by
 *   the next utterance, a focused user could miss a failure that a later spinner
 *   or success buries. The latch holds the failed utterance until the user
 *   reviews it (opens its row) or ends the session (disarm/restart), so failure
 *   breaks through where most-recent-wins is too weak. It is the pill pip's only
 *   persistent fact; the notification path stays on `outcome`.
 */
export type DictationCapture =
	| { kind: 'idle' }
	| { kind: 'recording'; trigger: 'manual' }
	| { kind: 'recording'; trigger: 'vad'; vadState: Exclude<VadState, 'IDLE'> };

export type DictationOutcome =
	| { kind: 'none' }
	| { kind: 'transcribing' }
	| { kind: 'delivered'; degraded: boolean }
	| ({ kind: 'failed' } & DictationFailure);

export type DictationLifecycle = {
	capture: DictationCapture;
	outcome: DictationOutcome;
	/** The latched VAD failure awaiting review, or `null`. Always `null` outside a
	 * live VAD session (cleared on disarm), so only the live VAD pip reads it. */
	unreviewedFailure: DictationFailure | null;
};

/** A dictation failure, carrying the live error object for the projection. */
export type DictationFailure = {
	tier: DictationFailureTier;
	error: AnyTaggedError;
	/** The recording row to retry/inspect, or `null` for a silent loss. */
	recordingId: string | null;
};

// How long the delivered checkmark flashes before the outcome retires to `none`.
// Sub-second: the transcribed text landing is the real receipt; this is a glance
// confirming it, not a notice to read. (A live VAD session projects `delivered`
// to no pip, so this flash only ever shows once capture is idle.)
const DELIVERED_FLASH_MS = 900;

function createDictationLifecycle() {
	// The outcome track is the ephemeral signal directly: `none` when no utterance
	// is in flight, otherwise the most-recent utterance's phase. Reset to `none`
	// when a new dictation begins so a stale `failed` never lingers past the next
	// attempt.
	let outcome = $state<DictationOutcome>({ kind: 'none' });
	// The VAD failure latch (see the type doc). Set by `markFailed` only when a
	// VAD session is live; cleared on review, disarm, or restart.
	let unreviewedFailure = $state<DictationFailure | null>(null);
	let deliveredTimer: ReturnType<typeof setTimeout> | undefined;

	function clearDeliveredTimer() {
		clearTimeout(deliveredTimer);
		deliveredTimer = undefined;
	}

	// The live session, read straight off the recorder machines. The pill owner is
	// the most-recent dictation, so a manual recording and a VAD session never
	// both report `recording` (only one recorder is live at a time).
	const capture = $derived.by((): DictationCapture => {
		if (manualRecorder.state === 'RECORDING')
			return { kind: 'recording', trigger: 'manual' };
		if (
			vadRecorder.state === 'LISTENING' ||
			vadRecorder.state === 'SPEECH_DETECTED'
		)
			return { kind: 'recording', trigger: 'vad', vadState: vadRecorder.state };
		return { kind: 'idle' };
	});

	const current = $derived<DictationLifecycle>({
		capture,
		outcome,
		unreviewedFailure,
	});

	return {
		/** The current lifecycle facts. Read reactively to project them. */
		get current(): DictationLifecycle {
			return current;
		},

		/**
		 * A new dictation is starting: clear any terminal outcome and the VAD
		 * failure latch from the last one so neither lingers into this attempt.
		 * (This is the latch's restart-clears path.)
		 */
		reset(): void {
			clearDeliveredTimer();
			outcome = { kind: 'none' };
			unreviewedFailure = null;
		},

		/** The recorder stopped (or a VAD utterance ended); now transcribing. */
		markTranscribing(): void {
			clearDeliveredTimer();
			outcome = { kind: 'transcribing' };
		},

		/**
		 * The transcript landed: flash a confirmation, then retire to `none`.
		 * `degraded` marks a clipboard-only fallback (a requested cursor write
		 * failed), which the manual pill notes instead of a clean delivered flash.
		 */
		markDelivered(degraded: boolean): void {
			clearDeliveredTimer();
			outcome = { kind: 'delivered', degraded };
			deliveredTimer = setTimeout(() => {
				deliveredTimer = undefined;
				// Only retire the flash if a newer outcome has not taken over.
				if (outcome.kind === 'delivered') outcome = { kind: 'none' };
			}, DELIVERED_FLASH_MS);
		},

		/** A dictation failed: hold the failed outcome until the next dictation. If
		 * the failure landed mid VAD session, also latch it so a later utterance's
		 * spinner or success cannot bury it before the user sees it. */
		markFailed(failure: DictationFailure): void {
			clearDeliveredTimer();
			outcome = { kind: 'failed', ...failure };
			if (capture.kind === 'recording' && capture.trigger === 'vad')
				unreviewedFailure = failure;
		},

		/**
		 * The user reviewed the latched VAD failure (opened its row) or ended the
		 * session (disarm). Clear the latch only; `outcome` is left alone so a
		 * just-failed utterance still shows on the idle pill after disarm.
		 */
		clearUnreviewedFailure(): void {
			unreviewedFailure = null;
		},
	};
}

export const dictationLifecycle = createDictationLifecycle();
