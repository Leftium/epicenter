import { rpc } from '$lib/rpc';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { settings } from '$lib/state/settings.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';
import type { Tauri } from '#platform/tauri';

export function syncWindowAlwaysOnTopWithRecorderState(tauri: Tauri) {
	$effect(() => {
		const setAlwaysOnTop = (value: boolean) =>
			tauri.window.setAlwaysOnTop(value);
		switch (settings.get('ui.alwaysOnTop')) {
			case 'Always':
				setAlwaysOnTop(true);
				break;
			case 'When Recording and Transcribing':
				if (
					manualRecorder.state === 'RECORDING' ||
					vadRecorder.state === 'SPEECH_DETECTED' ||
					rpc.transcription.isCurrentlyTranscribing()
				) {
					setAlwaysOnTop(true);
				} else {
					setAlwaysOnTop(false);
				}
				break;
			case 'When Recording':
				if (
					manualRecorder.state === 'RECORDING' ||
					vadRecorder.state === 'SPEECH_DETECTED'
				) {
					setAlwaysOnTop(true);
				} else {
					setAlwaysOnTop(false);
				}
				break;
			case 'Never':
				setAlwaysOnTop(false);
				break;
		}
	});
}
