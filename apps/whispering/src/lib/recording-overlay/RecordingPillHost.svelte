<script lang="ts">
	import { tauri } from '#platform/tauri';
	import {
		cancelRecording,
		retryDictation,
		stopManualRecording,
		stopVadRecording,
	} from '$lib/operations/recording';
	import { openFailedDictationDetail } from '$lib/recording-overlay/focus-failure';
	import RecordingPill from '$lib/recording-overlay/RecordingPill.svelte';
	import { projectLifecycleToStatus } from '$lib/recording-overlay/projection';
	import { webPillLevel } from '$lib/recording-overlay/web-pill.svelte';
	import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

	// The web mount of the shared dictation pill. On desktop the pill is a native
	// overlay window, so this host renders nothing there; on web it places the
	// same `RecordingPill` as a fixed bottom-center element and drives it straight
	// from the lifecycle value, calling the recorder operations directly (no IPC).
	const status = $derived(projectLifecycleToStatus(dictationLifecycle.current));

	function handleStop() {
		// Stop acts on whichever capture is live.
		const { capture } = dictationLifecycle.current;
		if (capture.kind !== 'recording') return;
		if (capture.trigger === 'manual') void stopManualRecording();
		else void stopVadRecording();
	}

	function handleCancel() {
		void cancelRecording();
	}

	function handleRetry() {
		void retryDictation();
	}

	function handleFocusMain() {
		// On web the app window is already the focused surface, so there is no
		// window to raise; a failure still opens the recording's row.
		openFailedDictationDetail();
	}
</script>

{#if !tauri && status}
	<div class="pill-host">
		<RecordingPill
			{status}
			level={webPillLevel.level}
			onStop={handleStop}
			onCancel={handleCancel}
			onRetry={handleRetry}
			onFocusMain={handleFocusMain}
		/>
	</div>
{/if}

<style>
	/* Bottom-center, matching the desktop overlay's resting position
	   (OVERLAY_BOTTOM_MARGIN). Above page content, below modals and toasts. */
	.pill-host {
		position: fixed;
		bottom: 72px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 50;
	}
</style>
