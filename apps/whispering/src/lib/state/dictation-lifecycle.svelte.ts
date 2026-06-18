import type { AnyTaggedError } from 'wellcrafted/error';
import type { VadState } from '$lib/constants/audio';
import type { DictationFailureTier } from '$lib/recording-overlay/events';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

/**
 * The single dictation lifecycle value owned by the main window. Every feedback
 * surface (the pill, and the exception projection) is a pure projection of it,
 * never an imperative emission. See ADR-0029.
 *
 * - `recording` is *derived* from the recorder state machines: a live capture
 *   is the most-recent dictation and owns the pill, so there is no second copy
 *   of "are we recording" to drift.
 * - `transcribing` / `delivered` / `failed` are the post-capture phases. The
 *   recordings row deliberately stores only terminal outcomes (liveness belongs
 *   to the process, not the row), so these come from an ephemeral in-memory
 *   process signal the pipeline drives, not from stored state. Because that
 *   signal is never persisted, there is no stored copy it can desync from.
 */
export type DictationLifecycle =
	| { phase: 'idle' }
	| { phase: 'recording'; trigger: 'manual' }
	| { phase: 'recording'; trigger: 'vad'; vadState: Exclude<VadState, 'IDLE'> }
	| { phase: 'transcribing' }
	| { phase: 'delivered'; degraded: boolean }
	| {
			phase: 'failed';
			tier: DictationFailureTier;
			error: AnyTaggedError;
			/** The recording row to retry/inspect, or `null` for a silent loss. */
			recordingId: string | null;
	  };

/** A dictation failure, carrying the live error object for the projection. */
export type DictationFailure = {
	tier: DictationFailureTier;
	error: AnyTaggedError;
	recordingId: string | null;
};

// How long the delivered checkmark flashes before the pill retires to idle.
// Sub-second: the transcribed text landing is the real receipt; this is a glance
// confirming it, not a notice to read.
const DELIVERED_FLASH_MS = 900;

/**
 * The post-capture process signal. Holds only the phases that happen once the
 * recorder is idle; `recording` is derived from the recorder machines, not from
 * here. Reset to `idle` when a new dictation begins, so a stale `failed` never
 * lingers past the next attempt.
 */
type ProcessSignal =
	| { kind: 'idle' }
	| { kind: 'transcribing' }
	| { kind: 'delivered'; degraded: boolean }
	| { kind: 'failed'; failure: DictationFailure };

function createDictationLifecycle() {
	let signal = $state<ProcessSignal>({ kind: 'idle' });
	let deliveredTimer: ReturnType<typeof setTimeout> | undefined;

	function clearDeliveredTimer() {
		clearTimeout(deliveredTimer);
		deliveredTimer = undefined;
	}

	const current = $derived.by((): DictationLifecycle => {
		// A live capture is the most-recent dictation and owns the pill, ahead of
		// any lingering terminal signal from a prior one (most-recent-wins).
		if (manualRecorder.state === 'RECORDING')
			return { phase: 'recording', trigger: 'manual' };
		if (
			vadRecorder.state === 'LISTENING' ||
			vadRecorder.state === 'SPEECH_DETECTED'
		)
			return {
				phase: 'recording',
				trigger: 'vad',
				vadState: vadRecorder.state,
			};
		switch (signal.kind) {
			case 'idle':
				return { phase: 'idle' };
			case 'transcribing':
				return { phase: 'transcribing' };
			case 'delivered':
				return { phase: 'delivered', degraded: signal.degraded };
			case 'failed':
				return { phase: 'failed', ...signal.failure };
		}
	});

	return {
		/** The current lifecycle value. Read reactively to project it. */
		get current(): DictationLifecycle {
			return current;
		},

		/**
		 * A new dictation is starting: clear any terminal state from the last one
		 * so a stale delivered flash or failed pill does not linger into it.
		 */
		reset(): void {
			clearDeliveredTimer();
			signal = { kind: 'idle' };
		},

		/** The recorder stopped; the pipeline is now transcribing. */
		markTranscribing(): void {
			clearDeliveredTimer();
			signal = { kind: 'transcribing' };
		},

		/**
		 * The transcript landed: flash a confirmation, then retire to idle.
		 * `degraded` marks a clipboard-only fallback (a requested cursor write
		 * failed), which the pill notes instead of a clean delivered flash.
		 */
		markDelivered(degraded: boolean): void {
			clearDeliveredTimer();
			signal = { kind: 'delivered', degraded };
			deliveredTimer = setTimeout(() => {
				deliveredTimer = undefined;
				// Only retire the flash if a newer phase has not taken over.
				if (signal.kind === 'delivered') signal = { kind: 'idle' };
			}, DELIVERED_FLASH_MS);
		},

		/** A dictation failed: hold the red pill until the next dictation. */
		markFailed(failure: DictationFailure): void {
			clearDeliveredTimer();
			signal = { kind: 'failed', failure };
		},
	};
}

export const dictationLifecycle = createDictationLifecycle();
