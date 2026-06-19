import type { AnyTaggedError } from 'wellcrafted/error';
import { goto } from '$app/navigation';
import { WHISPERING_RECORDINGS_PATHNAME } from '$lib/constants/urls';
import { type Notice, report } from '$lib/report';
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
 * history, so even the worst case (`history`) is a recoverable success, never a
 * dictation failure (ADR-0029). Delivery is an operation, not a notifier: it
 * returns this so each caller presents it on its own surface (the dictation
 * pill, or a toast for file import and row actions).
 *
 * - `output`: landed where configured (the cursor, the clipboard, or history
 *   when history is the only configured sink). The clean case.
 * - `clipboard`: a cursor write was requested but failed, so delivery fell back
 *   to the clipboard. Usable, but not where the user asked.
 * - `history`: a requested live channel errored and nothing landed at the cursor
 *   or clipboard. The transcript is still in history, recoverable from its row.
 */
export type DeliveryReach = 'output' | 'clipboard' | 'history';

export type DeliveryOutcome =
	| { reach: 'output' | 'clipboard' }
	| { reach: 'history'; error: AnyTaggedError };

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

	const copyToClipboardAction = {
		label: 'Copy to clipboard',
		onClick: async () => {
			const { error } = await services.text.copyToClipboard(text);
			if (error) {
				report.error({ title: "Couldn't copy to clipboard", cause: error });
				return;
			}
			report.success({ title: 'Copied to clipboard!', description: text });
		},
	};

	const clipboardRequested = settings.get(`output.${settingsScope}.clipboard`);
	const cursorRequested = settings.get(`output.${settingsScope}.cursor`);

	let copied = false;
	let written = false;
	let copyError: AnyTaggedError | null = null;
	let writeError: AnyTaggedError | null = null;

	if (clipboardRequested) {
		const { error } = await services.text.copyToClipboard(text);
		if (error) copyError = error;
		else copied = true;
	}

	if (cursorRequested) {
		const { error } = await services.text.writeToCursor(text);
		if (error) {
			writeError = error;
		} else {
			written = true;
			if (settings.get(`output.${settingsScope}.enter`)) {
				// The Enter keystroke is a nicety on top of a successful write; a
				// failure here does not change the delivery outcome.
				await services.text.simulateEnterKeystroke();
			}
		}
	}

	if (written) {
		return {
			outcome: { reach: 'output' },
			notice: {
				title: copied
					? `${successCopy}, copied to clipboard, and written to cursor!`
					: `${successCopy} and written to cursor!`,
				description: text,
				action: recordingsAction,
			},
		};
	}

	if (copied) {
		// Cursor was asked for but failed: clipboard is the fallback, a degraded
		// but usable delivery.
		const degraded = cursorRequested;
		return {
			outcome: { reach: degraded ? 'clipboard' : 'output' },
			notice: {
				title: degraded
					? `${successCopy}, copied to clipboard (couldn't write to cursor)`
					: `${successCopy} and copied to clipboard!`,
				description: text,
				action: recordingsAction,
			},
		};
	}

	// Nothing landed at the cursor or on the clipboard. If a channel was tried
	// and errored, that is a real delivery failure; if nothing was requested, the
	// transcript still lives in history, which is the user's chosen output.
	const error = copyError ?? writeError;
	if (error) {
		return {
			outcome: { reach: 'history', error },
			notice: {
				title: "Couldn't deliver transcription",
				description: text,
				cause: error,
				action: copyToClipboardAction,
			},
		};
	}

	return {
		outcome: { reach: 'output' },
		notice: {
			title: `${successCopy}!`,
			description: text,
			action: copyToClipboardAction,
		},
	};
}
