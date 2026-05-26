import { WHISPERING_RECORDINGS_PATHNAME } from '$lib/constants/app';
import { notify } from '$lib/operations/notify';
import type { WhisperingError } from '$lib/result';
import { services } from '$lib/services';
import type { TextError } from '$lib/services/text';
import { settings } from '$lib/state/settings.svelte';

/**
 * Delivers transcript to the user according to their text output preferences.
 *
 * Shows a success toast, optionally copies to clipboard, optionally writes to
 * cursor, and provides fallback UI actions when automatic operations fail.
 *
 * @param text - The transcript to deliver
 * @param toastId - Unique ID for toast notifications to prevent duplicates
 */
export async function deliverTranscriptionResult({
	text,
	toastId,
}: {
	text: string;
	toastId: string;
}) {
	let copied = false;
	let written = false;

	const offerManualCopy = () =>
		notify.success({
			id: toastId,
			title: '📝 Recording transcribed!',
			description: text,
			action: {
				type: 'button',
				label: 'Copy to clipboard',
				onClick: async () => {
					const { error } = await services.text.copyToClipboard(text);
					if (error) {
						notify.error({
							title: 'Error copying transcript to clipboard',
							description: error.message,
							action: { type: 'more-details', error },
						});
						return;
					}
					notify.success({
						id: toastId,
						title: 'Copied transcript to clipboard!',
						description: text,
					});
				},
			},
		});

	const warnAutoCopyFailed = (error: TextError) => {
		notify.warning({
			title: "Couldn't copy to clipboard",
			description: error.message,
			action: { type: 'more-details', error },
		});
	};

	const warnWriteToCursorFailed = (error: TextError | WhisperingError) => {
		if (error.name === 'WhisperingError') {
			notify[error.severity](error);
			return;
		}
		notify.warning({
			title: 'Unable to write to cursor automatically',
			description: error.message,
			action: { type: 'more-details', error },
		});
	};

	const showSuccessNotification = () => {
		if (copied && written) {
			notify.success({
				id: toastId,
				title:
					'📝 Recording transcribed, copied to clipboard, and written to cursor!',
				description: text,
				action: {
					type: 'link',
					label: 'Go to recordings',
					href: WHISPERING_RECORDINGS_PATHNAME,
				},
			});
		} else if (copied) {
			notify.success({
				id: toastId,
				title: '📝 Recording transcribed and copied to clipboard!',
				description: text,
				action: {
					type: 'link',
					label: 'Go to recordings',
					href: WHISPERING_RECORDINGS_PATHNAME,
				},
			});
		} else if (written) {
			notify.success({
				id: toastId,
				title: '📝 Recording transcribed and written to cursor!',
				description: text,
				action: {
					type: 'link',
					label: 'Go to recordings',
					href: WHISPERING_RECORDINGS_PATHNAME,
				},
			});
		} else {
			offerManualCopy();
		}
	};

	if (settings.get('output.transcription.clipboard')) {
		const { error: copyError } = await services.text.copyToClipboard(text);
		if (!copyError) {
			copied = true;
		} else {
			warnAutoCopyFailed(copyError);
		}
	}

	if (settings.get('output.transcription.cursor')) {
		const { error: writeError } = await services.text.writeToCursor(text);
		if (!writeError) {
			written = true;
			if (settings.get('output.transcription.enter')) {
				const { error: enterError } =
					await services.text.simulateEnterKeystroke();
				if (enterError) {
					notify.warning({
						title: 'Unable to simulate Enter keystroke',
						description: enterError.message,
						action: { type: 'more-details', error: enterError },
					});
				}
			}
		} else {
			warnWriteToCursorFailed(writeError);
		}
	}

	showSuccessNotification();
}

/**
 * Delivers transformed text to the user according to their text output preferences.
 *
 * Shows a success toast, optionally copies to clipboard, optionally writes to
 * cursor, and provides fallback UI actions when automatic operations fail.
 *
 * @param text - The transformed text to deliver
 * @param toastId - Unique ID for toast notifications to prevent duplicates
 */
export async function deliverTransformationResult({
	text,
	toastId,
}: {
	text: string;
	toastId: string;
}) {
	let copied = false;
	let written = false;

	const offerManualCopy = () =>
		notify.success({
			id: toastId,
			title: '🔄 Transformation complete!',
			description: text,
			action: {
				type: 'button',
				label: 'Copy to clipboard',
				onClick: async () => {
					const { error } = await services.text.copyToClipboard(text);
					if (error) {
						notify.error({
							title: 'Error copying transformed text to clipboard',
							description: error.message,
							action: { type: 'more-details', error },
						});
						return;
					}
					notify.success({
						id: toastId,
						title: 'Copied transformed text to clipboard!',
						description: text,
					});
				},
			},
		});

	const warnAutoCopyFailed = (error: TextError) => {
		notify.warning({
			title: "Couldn't copy to clipboard",
			description: error.message,
			action: { type: 'more-details', error },
		});
	};

	const warnWriteToCursorFailed = (error: TextError | WhisperingError) => {
		if (error.name === 'WhisperingError') {
			notify[error.severity](error);
			return;
		}
		notify.error({
			title: 'Error writing transformed text to cursor',
			description: error.message,
			action: { type: 'more-details', error },
		});
	};

	const showSuccessNotification = () => {
		if (copied && written) {
			notify.success({
				id: toastId,
				title:
					'🔄 Transformation complete, copied to clipboard, and written to cursor!',
				description: text,
				action: {
					type: 'link',
					label: 'Go to recordings',
					href: WHISPERING_RECORDINGS_PATHNAME,
				},
			});
		} else if (copied) {
			notify.success({
				id: toastId,
				title: '🔄 Transformation complete and copied to clipboard!',
				description: text,
				action: {
					type: 'link',
					label: 'Go to recordings',
					href: WHISPERING_RECORDINGS_PATHNAME,
				},
			});
		} else if (written) {
			notify.success({
				id: toastId,
				title: '🔄 Transformation complete and written to cursor!',
				description: text,
				action: {
					type: 'link',
					label: 'Go to recordings',
					href: WHISPERING_RECORDINGS_PATHNAME,
				},
			});
		} else {
			offerManualCopy();
		}
	};

	if (settings.get('output.transformation.clipboard')) {
		const { error: copyError } = await services.text.copyToClipboard(text);
		if (!copyError) {
			copied = true;
		} else {
			warnAutoCopyFailed(copyError);
		}
	}

	if (settings.get('output.transformation.cursor')) {
		const { error: writeError } = await services.text.writeToCursor(text);
		if (!writeError) {
			written = true;
			if (settings.get('output.transformation.enter')) {
				const { error: enterError } =
					await services.text.simulateEnterKeystroke();
				if (enterError) {
					notify.warning({
						title: 'Unable to simulate Enter keystroke',
						description: enterError.message,
						action: { type: 'more-details', error: enterError },
					});
				}
			}
		} else {
			warnWriteToCursorFailed(writeError);
		}
	}

	showSuccessNotification();
}
