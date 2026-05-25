import { nanoid } from 'nanoid/non-secure';
import { deliverTransformationResult } from '$lib/operations/delivery';
import { notify } from '$lib/operations/notify';
import { sound } from '$lib/operations/sound';
import { transformer } from '$lib/query/transformer';
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

	const { data: output, error: transformError } =
		await transformer.transformInput({
			input: clipboardText,
			transformation,
		});

	if (transformError) {
		notify.error({ id: toastId, ...transformError });
		return;
	}

	sound.playSoundIfEnabled('transformationComplete');

	await deliverTransformationResult({
		text: output,
		toastId,
	});
}
