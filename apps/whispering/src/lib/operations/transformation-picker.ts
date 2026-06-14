import { captureSelection } from '$lib/operations/selection';
import { report } from '$lib/report';
import * as transformationPickerWindow from '$routes/transformation-picker/transformationPickerWindow.tauri';

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

	await transformationPickerWindow.openWithSelection(selection);
}
