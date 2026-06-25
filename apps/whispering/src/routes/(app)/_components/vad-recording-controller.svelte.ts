import { createMutation } from '@tanstack/svelte-query';
import { VAD_RECORDING_BUTTON } from '$lib/constants/audio';
import { toggleVadRecording } from '$lib/operations/recording';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';
import { getRecordingShortcutLabel } from '$lib/utils/recording-shortcut';
import type { RecordingActionController } from './recording-action-controller';

/**
 * The voice-activated record button behavior, in the same shape as
 * `createManualRecordingController` so both feed `RecordingActionCard` through
 * one `controller` prop. VAD is a single toggle (its capture pipeline runs in a
 * separate speech-end callback, not in stop), so there is one mutation here, not
 * a start/stop pair.
 *
 * Call from a component's init: it creates a TanStack mutation.
 */
export function createVadRecordingController(): RecordingActionController {
	const toggleMutation = createMutation(() => ({
		mutationFn: toggleVadRecording,
	}));

	const isListening = $derived(vadRecorder.state !== 'IDLE');
	const isSpeechDetected = $derived(vadRecorder.state === 'SPEECH_DETECTED');
	// The live VAD signals the card draws beside its meter, as one memoized object
	// so `get vad()` returns a stable reference like every other member instead of
	// building a fresh object per read. `transcribing` is a previous phrase still
	// transcribing while this session keeps listening (the continuous-VAD overlap),
	// gated on listening so it only reads as "ours" while this session is live.
	const vad = $derived({
		speaking: isSpeechDetected,
		transcribing:
			isListening && dictationLifecycle.current.outcome.kind === 'transcribing',
	});
	const button = $derived(VAD_RECORDING_BUTTON[vadRecorder.state]);
	const shortcutLabel = $derived(getRecordingShortcutLabel('vad'));

	const description = $derived.by(() => {
		if (toggleMutation.isPending) return 'Updating voice activation';
		if (isSpeechDetected) return 'Speech detected';
		if (isListening) return 'Listening for speech';
		return 'Listen for speech';
	});
	const tooltip = $derived.by(() => {
		if (toggleMutation.isPending) return 'Updating voice activated session';
		if (isListening) return 'Stop voice activated session';
		return 'Start voice activated session';
	});

	return {
		get active() {
			return isListening;
		},
		get pending() {
			return toggleMutation.isPending;
		},
		get icon() {
			return button.Icon;
		},
		get label() {
			return button.label;
		},
		get description() {
			return description;
		},
		get tooltip() {
			return tooltip;
		},
		get shortcutLabel() {
			return shortcutLabel;
		},
		get vad() {
			return vad;
		},
		toggle() {
			toggleMutation.mutate();
		},
	};
}
