import type { RecordingOverlayStatus, VadOutcomePip } from './events';

/**
 * The live meter's secondary display facts, read from the projected status.
 *
 * The live meter is drawn on more than one surface: the floating pill and the
 * home capture card both render the same bars reacting to the same level. The
 * bars alone do not say everything, though, so each surface also shows a few
 * secondary signals beside them: whether this is a manual take, whether VAD has
 * latched onto speech, and whether a previous phrase is still transcribing. This
 * is the single read of those signals, so every surface speaks one visual
 * language from one source: add a signal here and both surfaces can render it,
 * instead of each surface re-deriving its own subset and drifting (the home
 * route silently dropping the transcribe pip is exactly that drift).
 */
type LiveMeterDisplay = {
	/** A manual take (mic glyph, discardable) rather than a VAD session. */
	isManual: boolean;
	/** VAD has latched onto speech: light the bars/dot past mere loudness. */
	isSpeaking: boolean;
	/** A previous VAD phrase is still transcribing beside the live meter, or
	 * undefined when nothing rides alongside (manual, or a VAD session at rest). */
	vadPip: VadOutcomePip | undefined;
};

/**
 * Read the live meter's secondary signals from a projected status. Returns the
 * resting facts (not manual, not speaking, no pip) for any non-recording status,
 * so callers can read it unconditionally and gate the meter on their own
 * "capturing now" signal.
 */
export function readLiveMeter(
	status: RecordingOverlayStatus | null,
): LiveMeterDisplay {
	return {
		isManual: status?.phase === 'recording' && status.trigger === 'manual',
		isSpeaking:
			status?.phase === 'recording' &&
			status.trigger === 'vad' &&
			status.vadState === 'SPEECH_DETECTED',
		vadPip:
			status?.phase === 'recording' && status.trigger === 'vad'
				? status.pip
				: undefined,
	};
}
