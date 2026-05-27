import { goto } from '$app/navigation';
import { deliverTransformationResult } from '$lib/operations/delivery';
import { sound } from '$lib/operations/sound';
import { runTransformation } from '$lib/operations/transform';
import { report } from '$lib/report';
import { services } from '$lib/services';
import { settings } from '$lib/state/settings.svelte';
import { transformations } from '$lib/state/transformations.svelte';
import * as transformClipboardWindow from '$routes/transform-clipboard/transformClipboardWindow.tauri';

export async function openTransformationPicker() {
	await transformClipboardWindow.toggle();
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

	const { data: transformedText, error: transformError } =
		await runTransformation({
			input: clipboardText,
			transformation,
			recordingId: null,
		});

	if (transformError) {
		loading.reject({ cause: transformError });
		return;
	}

	sound.playSoundIfEnabled('transformationComplete');

	const successNotice = await deliverTransformationResult({
		text: transformedText,
	});
	loading.resolve(successNotice);
}
