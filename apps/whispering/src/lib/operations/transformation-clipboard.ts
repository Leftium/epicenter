import { nanoid } from 'nanoid/non-secure';
import { deliverTransformationResult } from '$lib/operations/delivery';
import { notify } from '$lib/operations/notify';
import { sound } from '$lib/operations/sound';
import { runTransformation } from '$lib/operations/transform';
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
		notify.warning({
			title: '⚠️ No transformation selected',
			description: 'Please select a transformation in settings first.',
			action: {
				type: 'link',
				label: 'Select a transformation',
				href: '/transformations',
			},
		});
		return;
	}

	const transformation = transformations.get(transformationId);

	if (!transformation) {
		settings.set('transformation.selectedId', null);
		notify.warning({
			title: '⚠️ Transformation not found',
			description:
				'The selected transformation no longer exists. Please select a different one.',
			action: {
				type: 'link',
				label: 'Select a transformation',
				href: '/transformations',
			},
		});
		return;
	}

	const { data: clipboardText, error: readClipboardError } =
		await services.text.readFromClipboard();

	if (readClipboardError) {
		notify.error({
			title: '❌ Failed to read clipboard',
			description: readClipboardError.message,
			action: { type: 'more-details', error: readClipboardError },
		});
		return;
	}

	if (!clipboardText?.trim()) {
		notify.warning({
			title: '📋 Empty clipboard',
			description: 'Please copy some text before running a transformation.',
		});
		return;
	}

	const toastId = nanoid();
	notify.loading({
		id: toastId,
		title: '🔄 Running transformation...',
		description: 'Transforming your clipboard text...',
	});

	const { data: result, error: transformError } = await runTransformation({
		input: clipboardText,
		transformation,
		recordingId: null,
	});

	if (transformError) {
		notify.error({
			id: toastId,
			title: '⚠️ Transformation failed',
			description: transformError.message,
			action: { type: 'more-details', error: transformError },
		});
		return;
	}

	if (result.status === 'failed') {
		notify.error({
			id: toastId,
			title: '⚠️ Transformation error',
			description: result.error,
			action: { type: 'more-details', error: result.error },
		});
		return;
	}

	sound.playSoundIfEnabled('transformationComplete');

	await deliverTransformationResult({
		text: result.output,
		toastId,
	});
}
