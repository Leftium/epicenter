import { goto } from '$app/navigation';
import { WHISPERING_RECORDINGS_PATHNAME } from '$lib/constants/app';
import { report } from '$lib/report';
import { services } from '$lib/services';
import { settings } from '$lib/state/settings.svelte';

type TranscriptionSource = 'recording' | 'upload';

const TRANSCRIPTION_SUCCESS_COPY = {
	recording: '📝 Recording transcribed',
	upload: '📁 File transcribed',
} as const satisfies Record<TranscriptionSource, string>;

/**
 * Delivers transcript to the user according to their text output preferences
 * (copy to clipboard, write to cursor, simulate enter). Side-effect failures
 * surface as independent toasts. Returns the success Notice the caller passes
 * to `loading.resolve(...)`; ownership of the loading handle stays with the
 * caller.
 */
export async function deliverTranscriptionResult({
	text,
	source = 'recording',
}: {
	text: string;
	source?: TranscriptionSource;
}) {
	return deliverResult({
		text,
		successCopy: TRANSCRIPTION_SUCCESS_COPY[source],
		settingsScope: 'transcription',
	});
}

/**
 * Delivers transformed text to the user according to their text output
 * preferences. Returns the success Notice the caller passes to
 * `loading.resolve(...)`.
 */
export async function deliverTransformationResult({ text }: { text: string }) {
	return deliverResult({
		text,
		successCopy: '🔄 Transformation complete',
		settingsScope: 'transformation',
	});
}

async function deliverResult({
	text,
	successCopy,
	settingsScope,
}: {
	text: string;
	successCopy: string;
	settingsScope: 'transcription' | 'transformation';
}) {
	const goToRecordings = {
		label: 'Go to recordings',
		onClick: () => goto(WHISPERING_RECORDINGS_PATHNAME),
	};

	const copyToClipboardAction = {
		label: 'Copy to clipboard',
		onClick: async () => {
			const { error } = await services.text.copyToClipboard(text);
			if (error) {
				report.error({
					title: "Couldn't copy to clipboard",
					cause: error,
				});
				return;
			}
			report.success({
				title: 'Copied to clipboard!',
				description: text,
			});
		},
	};

	let copied = false;
	let written = false;

	if (settings.get(`output.${settingsScope}.clipboard`)) {
		const { error: copyError } = await services.text.copyToClipboard(text);
		if (!copyError) {
			copied = true;
		} else {
			report.error({
				title: "Couldn't copy to clipboard",
				cause: copyError,
			});
		}
	}

	if (settings.get(`output.${settingsScope}.cursor`)) {
		const { error: writeError } = await services.text.writeToCursor(text);
		if (!writeError) {
			written = true;
			if (settings.get(`output.${settingsScope}.enter`)) {
				const { error: enterError } =
					await services.text.simulateEnterKeystroke();
				if (enterError) {
					report.info({
						title: 'Unable to simulate Enter keystroke',
						cause: enterError,
					});
				}
			}
		} else {
			report.info({
				title: 'Unable to write to cursor automatically',
				cause: writeError,
				action: copyToClipboardAction,
			});
		}
	}

	if (copied && written) {
		return {
			title: `${successCopy}, copied to clipboard, and written to cursor!`,
			description: text,
			action: goToRecordings,
		};
	}
	if (copied) {
		return {
			title: `${successCopy} and copied to clipboard!`,
			description: text,
			action: goToRecordings,
		};
	}
	if (written) {
		return {
			title: `${successCopy} and written to cursor!`,
			description: text,
			action: goToRecordings,
		};
	}
	return {
		title: `${successCopy}!`,
		description: text,
		action: copyToClipboardAction,
	};
}
