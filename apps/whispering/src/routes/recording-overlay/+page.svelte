<script lang="ts">
	import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import RecordingPill from '$lib/recording-overlay/RecordingPill.svelte';
	import {
		RECORDING_OVERLAY_ACTION,
		RECORDING_OVERLAY_FOCUS_MAIN,
		RECORDING_OVERLAY_MIC_LEVEL,
		RECORDING_OVERLAY_READY,
		RECORDING_OVERLAY_STATUS,
		type RecordingOverlayAction,
		type RecordingOverlayStatus,
	} from '$lib/recording-overlay/events';

	// Tauri adapter for the recording pill. The overlay lives in its own webview,
	// so it cannot read the recorder state modules directly: the main window
	// pushes the current status over a Tauri event and we render from that, and
	// control gestures go back over Tauri events. The pill itself
	// (`RecordingPill`) is platform-free; this route owns the IPC glue.
	let status = $state<RecordingOverlayStatus | null>(null);

	// Live, smoothed mic loudness, 0 (silent) to 1 (loud). Driven by the
	// `mic-level` event: VAD frames in JS for voice-activated capture, the Rust
	// CPAL worker for manual recording. Both send a raw RMS amplitude; we apply
	// the perceptual curve and smoothing here so the bars react to the actual
	// voice rather than looping on a timer.
	let level = $state(0);

	// Raw RMS for speech is small (~0.05 quiet, ~0.2 loud); this gain on a sqrt
	// curve maps that range across the meter without clipping early.
	const LEVEL_GAIN = 2.4;

	const unlisteners: UnlistenFn[] = [];

	onMount(async () => {
		unlisteners.push(
			await listen<RecordingOverlayStatus>(
				RECORDING_OVERLAY_STATUS,
				(event) => {
					status = event.payload;
				},
			),
			await listen<number>(RECORDING_OVERLAY_MIC_LEVEL, (event) => {
				const normalized = Math.min(1, Math.sqrt(event.payload) * LEVEL_GAIN);
				// Exponential smoothing so the bars glide instead of jittering.
				level = level * 0.6 + normalized * 0.4;
			}),
		);
		// Tell the main window we are ready so it re-sends the latest status.
		// Without this handshake the status emitted right after window creation
		// can land before our listener is attached.
		await emit(RECORDING_OVERLAY_READY);
	});

	onDestroy(() => {
		for (const unlisten of unlisteners) unlisten();
	});

	function sendAction(action: RecordingOverlayAction) {
		void emit(RECORDING_OVERLAY_ACTION, action);
	}

	function focusMainWindow() {
		void emit(RECORDING_OVERLAY_FOCUS_MAIN);
	}
</script>

<RecordingPill
	{status}
	{level}
	onStop={() => sendAction('stop')}
	onCancel={() => sendAction('cancel')}
	onFocusMain={focusMainWindow}
/>

<style>
	/* These `:global` document rules belong to the overlay webview, not the pill:
	   they are only ever loaded in the dedicated overlay Tauri window, which has
	   its own document. The main app window never navigates here, so its document
	   background is untouched. (The isolation comes from the separate webview
	   document, not from Svelte's component scoping.) The shared `RecordingPill`
	   keeps no document-level styles so it can also mount inside the app on web. */
	:global(html),
	:global(body) {
		background: transparent !important;
		margin: 0;
		overflow: hidden;
		/* The app shell forces a dark theme (ModeWatcher sets color-scheme:dark),
		   which makes the browser paint a dark canvas behind the pill in this
		   transparent webview. Reset it so only the pill is visible. */
		color-scheme: normal !important;
	}

	/* The Svelte inspector toggle (svelte.config.js `showToggleButton: always`)
	   is injected into every dev document, including this overlay webview where
	   it overlaps the pill. Hide it here; this rule lives only in the overlay
	   webview's document, and the host element does not exist in production. */
	:global(#svelte-inspector-host) {
		display: none !important;
	}
</style>
