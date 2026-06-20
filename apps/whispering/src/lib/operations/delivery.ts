import { goto } from '$app/navigation';
import { WHISPERING_RECORDINGS_PATHNAME } from '$lib/constants/urls';
import type { Notice } from '$lib/report';
import { services } from '$lib/services';
import { settings } from '$lib/state/settings.svelte';

/**
 * The output scopes Whispering delivers into. Each has its own
 * clipboard/cursor/enter toggles under `output.<scope>.*`. Keeping the list in
 * one place lets delivery and the tap-hold capability derive from the same
 * source instead of hardcoding the scope names.
 */
const OUTPUT_SCOPES = ['transcription', 'transformation'] as const;
type OutputScope = (typeof OUTPUT_SCOPES)[number];

/**
 * True when any output scope is set to write at the cursor. Cursor delivery is a
 * synthetic Cmd/Ctrl+V, so this is exactly when delivery needs the macOS
 * Accessibility grant, which is the one fact the tap supervisor holds the tap to
 * track. Call inside a reactive scope to stay live as the toggles change.
 */
export function outputWritesToCursor(): boolean {
	return OUTPUT_SCOPES.some((scope) => settings.get(`output.${scope}.cursor`));
}

/**
 * Where a transcript originated: a live `recording` or an imported file
 * (`import`). Shapes the success copy and flows in from the pipeline's
 * `deliverySource`.
 */
export type TranscriptionSource = 'recording' | 'import';

const TRANSCRIPTION_SUCCESS_COPY = {
	recording: '📝 Recording transcribed',
	import: '📁 File transcribed',
} as const satisfies Record<TranscriptionSource, string>;

/**
 * How far the text reached, relative to the user's configured output. Delivery
 * is a reduced-reach axis, not a pass/fail: the transcript is always saved to
 * history, so a reduced reach is a recoverable success, never a dictation failure
 * (ADR-0029). Delivery is an operation, not a notifier: it returns this so each
 * caller presents it on its own surface (the dictation pill, or a toast for file
 * import and row actions).
 *
 * - `output`: landed where configured — pasted at the cursor, or copied to the
 *   clipboard / saved to history when that is the configured sink. The clean case.
 * - `clipboard`: a cursor write was requested but could not paste (no
 *   Accessibility grant, or the paste failed), so the transcript was left on the
 *   clipboard. Usable, but not where the user asked.
 *
 * There is no `history`-only reach: a cursor write that cannot paste always leaves
 * the transcript on the clipboard (see `write_text` in src-tauri), so the text is
 * never stranded somewhere the user would not look.
 */
export type DeliveryReach = 'output' | 'clipboard';

export type DeliveryOutcome = { reach: DeliveryReach };

/** A delivery result: the structured outcome plus a human notice for toasts. */
export type DeliveryResult = { outcome: DeliveryOutcome; notice: Notice };

/**
 * Delivers transcript to the user according to their text output preferences
 * (copy to clipboard, write to cursor, simulate enter). Returns the structured
 * outcome plus a human notice; it does not toast. The dictation path reads the
 * outcome to drive the pill; file import and row actions show the notice.
 */
export async function deliverTranscriptionResult({
	text,
	source = 'recording',
}: {
	text: string;
	source?: TranscriptionSource;
}): Promise<DeliveryResult> {
	return deliverResult({
		text,
		successCopy: TRANSCRIPTION_SUCCESS_COPY[source],
		settingsScope: 'transcription',
		// A transcription always belongs to a recording, so its history is reachable.
		linkedRecording: true,
	});
}

/**
 * Delivers transformed text to the user according to their text output
 * preferences. Returns the structured outcome plus a human notice. `recordingId`
 * is the run's link to a recording, or null for ad-hoc runs (clipboard,
 * selection): only a recording-anchored run offers a "go to recordings" action,
 * since an ad-hoc run has no history to open.
 */
export async function deliverTransformationResult({
	text,
	recordingId,
}: {
	text: string;
	recordingId: string | null;
}): Promise<DeliveryResult> {
	return deliverResult({
		text,
		successCopy: '🔄 Transformation complete',
		settingsScope: 'transformation',
		linkedRecording: recordingId !== null,
	});
}

async function deliverResult({
	text,
	successCopy,
	settingsScope,
	linkedRecording,
}: {
	text: string;
	successCopy: string;
	settingsScope: OutputScope;
	linkedRecording: boolean;
}): Promise<DeliveryResult> {
	const recordingsAction = linkedRecording
		? {
				label: 'Go to recordings',
				onClick: () => goto(WHISPERING_RECORDINGS_PATHNAME),
			}
		: undefined;

	const clipboardRequested = settings.get(`output.${settingsScope}.clipboard`);
	const cursorRequested = settings.get(`output.${settingsScope}.cursor`);

	// The clipboard is the configured destination when requested, and doubles as
	// the transport and fallback for a cursor write. Best-effort: a clipboard write
	// effectively never fails, and the transcript is in history regardless, so its
	// error does not change the reach.
	if (clipboardRequested) await services.text.copyToClipboard(text);

	// No cursor write requested: the transcript reached its configured sink (the
	// clipboard, or history when nothing else is configured). The clean case.
	if (!cursorRequested) {
		return {
			outcome: { reach: 'output' },
			notice: {
				title: `${successCopy}!`,
				description: text,
				action: recordingsAction,
			},
		};
	}

	// Cursor write requested. `write_text` decides from the Accessibility grant
	// whether it can paste and reports where the transcript landed: `pasted` at the
	// cursor (clean), or `leftOnClipboard` when it could not paste.
	const { data: writeOutcome, error: writeError } =
		await services.text.writeToCursor(text);

	if (writeError) {
		// The write failed outright (rare). Ensure the transcript is at least on the
		// clipboard, and report the reduced reach.
		await services.text.copyToClipboard(text);
		return {
			outcome: { reach: 'clipboard' },
			notice: {
				title: `${successCopy}, copied to clipboard (couldn't write to cursor)`,
				description: text,
				action: recordingsAction,
			},
		};
	}

	if (writeOutcome === 'pasted') {
		if (settings.get(`output.${settingsScope}.enter`)) {
			// The Enter keystroke is a nicety on top of a successful write; a failure
			// here does not change the delivery outcome.
			await services.text.simulateEnterKeystroke();
		}
		return {
			outcome: { reach: 'output' },
			notice: {
				title: `${successCopy} and written to cursor!`,
				description: text,
				action: recordingsAction,
			},
		};
	}

	// `leftOnClipboard`: couldn't paste, so the transcript is on the clipboard.
	return {
		outcome: { reach: 'clipboard' },
		notice: {
			title: `${successCopy}, copied to clipboard (couldn't write to cursor)`,
			description: text,
			action: recordingsAction,
		},
	};
}
