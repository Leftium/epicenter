import type { VadState } from '$lib/constants/audio';
import { defineWindowEvent, defineWindowSignal } from '$lib/window-events';

/**
 * Event contract for the recording overlay window.
 *
 * The overlay lives in its own webview and therefore cannot read the recorder
 * state modules directly. The main window pushes the current status to the
 * overlay, and the overlay pushes user actions back. The channels below carry
 * that traffic; each binds its name to its payload so emitter and listener stay
 * in sync (see `defineWindowEvent`).
 *
 * This module imports no Tauri runtime APIs beyond the typed-channel helper, so
 * it stays loadable on web (where the overlay never exists) and from the overlay
 * page itself.
 */

/**
 * How severe a dictation failure is, which decides how loudly it surfaces.
 * Severity is a function of where the dictation failed, not the error's name:
 *
 * - `silent-loss`: the recording never started (no mic, denied permission), so
 *   there is no artifact to recover. Loudest, because the user spoke into
 *   nothing.
 * - `transcription`: the recording was captured (a recordings row exists) but
 *   transcription failed. The audio is safe and the failure is retryable.
 * - `delivery`: the text transcribed but paste/injection failed. Quietest, the
 *   text is already on the clipboard.
 */
export type DictationFailureTier = 'silent-loss' | 'transcription' | 'delivery';

/**
 * The secondary pip riding alongside a live VAD meter, when there is one. In a
 * continuous session the meter (listening) and the per-utterance work run at
 * once, so the work shows as a small pip on the meter rather than replacing it:
 * `transcribing` is a spinner, `failed` is a red mark, and an absent pip is the
 * resting state. There is deliberately no `delivered` pip: the landing text is
 * the receipt, so a continuous session shows no per-utterance success flash
 * (ADR-0029). Failure outranks transcribing, so an unreviewed failure stays red
 * even while the next utterance is in flight.
 */
export type VadOutcomePip = 'transcribing' | 'failed';

/**
 * What the pill should display, the serializable projection of the main
 * window's dictation lifecycle. Only the non-idle phases are representable: an
 * idle dictation hides the pill rather than emitting a status, so there is no
 * `idle` variant to render. The `failed` variant carries only a terse `title`
 * string (never the live error object) so it can cross the Tauri IPC boundary
 * to the overlay webview; the full error detail lives on the recordings row.
 *
 * The VAD `recording` variant may also carry `pip`: the live meter is the
 * primary content, and a concurrent utterance's work rides beside it. The pip is
 * absent (omitted) when nothing rides alongside.
 */
export type RecordingOverlayStatus =
	| { phase: 'recording'; trigger: 'manual' }
	| {
			phase: 'recording';
			trigger: 'vad';
			vadState: Exclude<VadState, 'IDLE'>;
			pip?: VadOutcomePip;
	  }
	| { phase: 'transcribing' }
	| { phase: 'delivered'; degraded: boolean }
	| { phase: 'failed'; tier: DictationFailureTier; title: string };

/**
 * The control the user invoked from the overlay. `stop`/`cancel` act on a live
 * capture; `retry` re-runs a failed dictation.
 */
export type RecordingOverlayAction = 'stop' | 'cancel' | 'retry';

/** main -> overlay: what to display, or that the overlay is shown. */
export const recordingOverlayStatus = defineWindowEvent<RecordingOverlayStatus>(
	'recording-overlay:status',
);

/** overlay -> main: the user clicked stop, cancel, or retry. */
export const recordingOverlayAction = defineWindowEvent<RecordingOverlayAction>(
	'recording-overlay:action',
);

/**
 * overlay -> main: the overlay mounted and its listener is live, so the main
 * window should re-send the latest status. Without this handshake the first
 * status can be emitted before the overlay's listener is attached and get lost.
 */
export const recordingOverlayReady = defineWindowSignal(
	'recording-overlay:ready',
);

/**
 * overlay -> main: the user clicked the pill body, which also opens the failed
 * recording's row when the pill is reporting a failure (ADR-0029). Kept separate
 * from the generic `revealMainWindow` (which only raises the window) because
 * opening the failed row and clearing the failure latch need the dictation
 * lifecycle, which lives in the main window; routing it through the shared reveal
 * would let it hijack another window's reveal. A no-op when no failure is shown.
 */
export const recordingOverlayFocusFailure = defineWindowSignal(
	'recording-overlay:focus-failure',
);

/**
 * Live mic level (main -> overlay), a raw RMS amplitude (~0 silent, ~0.3 loud
 * speech). The overlay applies the perceptual gain and smoothing so both
 * producers, VAD frames in JS and the CPAL worker in Rust, can stay dumb and
 * just report RMS. The name stays the bare string `mic-level` because the Rust
 * recorder emits the same channel (see recorder.rs `MIC_LEVEL_EVENT`).
 */
export const recordingOverlayMicLevel = defineWindowEvent<number>('mic-level');
