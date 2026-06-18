import type { VadState } from '$lib/constants/audio';

/**
 * Event contract for the recording overlay window.
 *
 * The overlay lives in its own webview and therefore cannot read the recorder
 * state modules directly. The main window pushes the current status to the
 * overlay, and the overlay pushes user actions back. Three Tauri event
 * channels carry that traffic:
 *
 * - `status` (main -> overlay): what to display, or that the overlay is shown.
 * - `action` (overlay -> main): the user clicked stop or cancel.
 * - `ready`  (overlay -> main): the overlay mounted and its listener is live,
 *   so the main window should re-send the latest status. Without this
 *   handshake the first status can be emitted before the overlay's listener
 *   is attached and get lost.
 *
 * This module imports no Tauri APIs so it stays loadable on web (where the
 * overlay never exists) and from the overlay page itself.
 */
export const RECORDING_OVERLAY_STATUS = 'recording-overlay:status';
export const RECORDING_OVERLAY_ACTION = 'recording-overlay:action';
export const RECORDING_OVERLAY_READY = 'recording-overlay:ready';
/**
 * Clicking the pill body (anywhere that is not a control) asks the main window
 * to come to the front. Kept separate from `action` so it never routes through
 * the recorder: stop/cancel only stop/cancel, and revealing the window is its
 * own gesture.
 */
export const RECORDING_OVERLAY_FOCUS_MAIN = 'recording-overlay:focus-main';
/**
 * Live mic level (main -> overlay), a raw RMS amplitude (~0 silent, ~0.3 loud
 * speech). The overlay applies the perceptual gain and smoothing so both
 * producers, VAD frames in JS and the CPAL worker in Rust, can stay dumb and
 * just report RMS. Kept as the bare string `mic-level` because the Rust
 * recorder emits the same channel (see recorder.rs `MIC_LEVEL_EVENT`).
 */
export const RECORDING_OVERLAY_MIC_LEVEL = 'mic-level';

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
 * What the pill should display, the serializable projection of the main
 * window's dictation lifecycle. Only the non-idle phases are representable: an
 * idle dictation hides the pill rather than emitting a status, so there is no
 * `idle` variant to render. The `failed` variant carries only a terse `title`
 * string (never the live error object) so it can cross the Tauri IPC boundary
 * to the overlay webview; the full error detail lives on the recordings row.
 */
export type RecordingOverlayStatus =
	| { phase: 'recording'; trigger: 'manual' }
	| { phase: 'recording'; trigger: 'vad'; vadState: Exclude<VadState, 'IDLE'> }
	| { phase: 'transcribing' }
	| { phase: 'delivered'; degraded: boolean }
	| { phase: 'failed'; tier: DictationFailureTier; title: string };

/**
 * The control the user invoked from the overlay. `stop`/`cancel` act on a live
 * capture; `retry` re-runs a failed dictation.
 */
export type RecordingOverlayAction = 'stop' | 'cancel' | 'retry';
