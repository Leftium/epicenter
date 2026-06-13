import { goto } from '$app/navigation';
import { deliverTransformationResult } from '$lib/operations/delivery';
import { captureSelection } from '$lib/operations/selection';
import { sound } from '$lib/operations/sound';
import {
	executeTransformation,
	persistCompletedRun,
} from '$lib/operations/transform';
import { report } from '$lib/report';
import { services } from '$lib/services';
import { settings } from '$lib/state/settings.svelte';
import { transformations } from '$lib/state/transformations.svelte';
import * as transformClipboardWindow from '$routes/transform-clipboard/transformClipboardWindow.tauri';

/**
 * Open the transformation picker on the user's current selection. Capture happens
 * here, while the source app is still frontmost (the global shortcut fired
 * without stealing focus), so the simulated copy reads from the right app. The
 * window is shown only after a non-empty selection is captured.
 */
export async function openTransformationPicker() {
	const { data: selection, error: captureError } = await captureSelection();

	if (captureError) {
		report.error({
			title: 'Could not capture your selection',
			cause: captureError,
		});
		return;
	}

	if (!selection?.trim()) {
		report.info({
			title: 'Nothing selected',
			description: 'Select some text in any app, then try again.',
		});
		return;
	}

	await transformClipboardWindow.openWithSelection(selection);
}

export async function runTransformationOnClipboard() {
	const transformationId = settings.get('transformation.selectedId');

	if (!transformationId) {
		report.info({
			title: 'No transformation selected',
			description: 'Please select a transformation in settings first.',
			action: {
				label: 'Select a transformation',
				onClick: () => goto('/transformations'),
			},
		});
		return;
	}

	const transformation = transformations.get(transformationId);

	if (!transformation) {
		settings.set('transformation.selectedId', null);
		report.info({
			title: 'Transformation not found',
			description:
				'The selected transformation no longer exists. Please select a different one.',
			action: {
				label: 'Select a transformation',
				onClick: () => goto('/transformations'),
			},
		});
		return;
	}

	const { data: clipboardText, error: readClipboardError } =
		await services.text.readFromClipboard();

	if (readClipboardError) {
		report.error({
			title: 'Failed to read clipboard',
			cause: readClipboardError,
		});
		return;
	}

	if (!clipboardText?.trim()) {
		report.info({
			title: 'Empty clipboard',
			description: 'Please copy some text before running a transformation.',
		});
		return;
	}

	const loading = report.loading({
		title: '🔄 Running transformation...',
		description: 'Transforming your clipboard text...',
	});

	// Ad-hoc run: execute purely, then commit one completed row only on success.
	// A failed quick-run never committed, so it leaves no record.
	const startedAt = new Date().toISOString();
	const { data: transformedText, error: transformError } =
		await executeTransformation({ input: clipboardText, transformation });

	if (transformError) {
		loading.reject({ cause: transformError });
		return;
	}

	persistCompletedRun({
		transformationId: transformation.id,
		input: clipboardText,
		output: transformedText,
		startedAt,
	});

	sound.playSoundIfEnabled('transformationComplete');

	const successNotice = await deliverTransformationResult({
		text: transformedText,
		recordingId: null,
	});
	loading.resolve(successNotice);
}
