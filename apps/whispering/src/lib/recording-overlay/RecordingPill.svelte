<script lang="ts">
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import CheckIcon from '@lucide/svelte/icons/check';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import MicIcon from '@lucide/svelte/icons/mic';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SquareIcon from '@lucide/svelte/icons/square';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import XIcon from '@lucide/svelte/icons/x';
	import type { RecordingOverlayStatus } from '$lib/recording-overlay/events';

	// The floating dictation pill, presentational and platform-free. It renders
	// whatever status it is handed and reports control gestures through callback
	// props; it never reads recorder state or touches Tauri. The Tauri build
	// drives it over IPC from a dedicated overlay webview; the web build mounts it
	// directly in the app layout. Both feed the same `status` and `level`.
	let {
		status,
		level,
		onStop,
		onCancel,
		onRetry,
		onFocusMain,
	}: {
		/** What to display, or `null` when the dictation is idle (hidden). */
		status: RecordingOverlayStatus | null;
		/** Live, smoothed mic loudness, 0 (silent) to 1 (loud). */
		level: number;
		/** Stop the live capture (stop recording / stop listening). */
		onStop: () => void;
		/** Discard the live manual recording. */
		onCancel: () => void;
		/** Re-run the failed dictation. */
		onRetry: () => void;
		/** Bring the main window to the front (and open the failure detail). */
		onFocusMain: () => void;
	} = $props();

	const isManual = $derived(
		status?.phase === 'recording' && status.trigger === 'manual',
	);
	const isSpeaking = $derived(
		status?.phase === 'recording' &&
			status.trigger === 'vad' &&
			status.vadState === 'SPEECH_DETECTED',
	);

	// Per-bar height envelope (taller in the middle) scaled by `level`. Reacting
	// the same amplitude through a fixed shape reads as a meter, not a flat block.
	const BAR_ENVELOPE = [0.5, 0.72, 0.9, 1, 0.9, 0.72, 0.5];
	const MIN_BAR_PX = 3;
	const MAX_BAR_PX = 18;

	function barHeight(envelope: number): number {
		return MIN_BAR_PX + envelope * level * (MAX_BAR_PX - MIN_BAR_PX);
	}

	function handleStop(event: MouseEvent) {
		// Don't let a button click bubble to the pill's focus-main handler:
		// stop/cancel should only stop/cancel, never reveal the main window.
		event.stopPropagation();
		onStop();
	}

	function handleCancel(event: MouseEvent) {
		event.stopPropagation();
		onCancel();
	}

	function handleRetry(event: MouseEvent) {
		event.stopPropagation();
		onRetry();
	}
</script>

<!-- The pill is non-focusable on desktop (an overlay window) and decorative on
     web, so it can never receive keyboard focus; clicking its body (not a
     button) just brings the main window forward. Keyboard handlers are moot
     here, hence the a11y ignores. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
{#if status}
	<div
		class="overlay"
		class:speaking={isSpeaking}
		class:failed={status.phase === 'failed'}
		title={status.phase === 'failed' ? status.title : 'Open Whispering'}
		onclick={onFocusMain}
	>
		{#if status.phase === 'recording'}
			<div class="icon">
				{#if isManual}
					<MicIcon class="size-4" />
				{:else}
					<AudioLinesIcon class="size-4" />
				{/if}
			</div>

			<div class="bars" aria-hidden="true">
				{#each BAR_ENVELOPE as envelope, i (i)}
					<span class="bar" style="height: {barHeight(envelope)}px"></span>
				{/each}
			</div>

			<div class="actions">
				<button
					type="button"
					class="action stop"
					aria-label={isManual ? 'Stop recording' : 'Stop listening'}
					title={isManual ? 'Stop recording' : 'Stop listening'}
					onclick={handleStop}
				>
					<SquareIcon class="size-3.5" />
				</button>
				{#if isManual}
					<button
						type="button"
						class="action cancel"
						aria-label="Cancel recording"
						title="Cancel recording"
						onclick={handleCancel}
					>
						<XIcon class="size-4" />
					</button>
				{/if}
			</div>
		{:else if status.phase === 'transcribing'}
			<div class="icon">
				<LoaderCircleIcon class="size-4 animate-spin" />
			</div>
			<span class="label">Transcribing</span>
		{:else if status.phase === 'delivered'}
			<div class="icon" class:delivered-icon={!status.degraded} class:degraded-icon={status.degraded}>
				<CheckIcon class="size-4" />
			</div>
			<span class="label">
				{status.degraded ? 'Copied to clipboard' : 'Delivered'}
			</span>
		{:else if status.phase === 'failed'}
			<div class="icon">
				<TriangleAlertIcon class="size-4" />
			</div>
			<span class="label">{status.title}</span>
			<div class="actions">
				<button
					type="button"
					class="action retry"
					aria-label="Retry dictation"
					title="Retry"
					onclick={handleRetry}
				>
					<RotateCcwIcon class="size-3.5" />
				</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.overlay {
		display: flex;
		align-items: center;
		gap: 8px;
		/* The pill is a fixed-height chip. On desktop it fills the 40px overlay
		   window; on web the mount site positions a 40px-tall element. */
		height: 40px;
		padding: 0 10px;
		box-sizing: border-box;
		border-radius: 9999px;
		background: rgba(15, 15, 17, 0.82);
		border: 1px solid rgba(255, 255, 255, 0.08);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
		color: rgba(255, 255, 255, 0.92);
		-webkit-backdrop-filter: blur(12px);
		backdrop-filter: blur(12px);
		user-select: none;
		-webkit-user-select: none;
		/* The body is clickable (opens the main window); the action buttons
		   stop propagation so only the empty areas trigger it. */
		cursor: pointer;
	}

	/* Failed: a red chip so the failure reads at a glance, with the terse reason
	   in the label and Retry inline. */
	.overlay.failed {
		background: rgba(60, 18, 22, 0.92);
		border-color: rgba(239, 68, 68, 0.55);
	}

	.icon {
		display: flex;
		align-items: center;
		color: rgba(255, 255, 255, 0.85);
	}

	.delivered-icon {
		color: #7ee2a8;
	}

	/* Clipboard-only fallback: amber, so the glance reads "landed, but not where
	   you asked" rather than a clean success. */
	.degraded-icon {
		color: #f5c97b;
	}

	.overlay.failed .icon {
		color: #ffb4b4;
	}

	/* The middle slot grows to fill the pill, matching the recording meter's
	   1fr column. Text ellipsizes; the full reason is in the title tooltip, the
	   OS notification, and the recordings row. */
	.label {
		flex: 1;
		min-width: 0;
		font-size: 13px;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.bars {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 3px;
		height: 20px;
	}

	.bar {
		width: 3px;
		border-radius: 9999px;
		background: rgba(255, 255, 255, 0.85);
		/* Height is set inline from the live mic level; the transition glides
		   between samples (~20-30 Hz) so the meter looks continuous. */
		transition: height 80ms linear;
	}

	/* Speech detected (VAD): tint the meter so the user sees it cross the
	   threshold, on top of the height already reacting to loudness. */
	.overlay.speaking .bar {
		background: #ffe5ee;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	/* Resting state is a filled chip, not a bare icon, so the controls read as
	   buttons at a glance in the small pill. */
	.action {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border: none;
		border-radius: 9999px;
		background: rgba(255, 255, 255, 0.1);
		color: rgba(255, 255, 255, 0.92);
		cursor: pointer;
		transition:
			background-color 150ms ease-out,
			color 150ms ease-out,
			transform 100ms ease-out;
	}

	.action:hover {
		transform: scale(1.08);
	}

	.action:active {
		transform: scale(0.95);
	}

	/* Stop is the primary action: a red chip so it reads as "stop recording". */
	.action.stop {
		background: rgba(239, 68, 68, 0.28);
		color: #fff;
	}

	.action.stop:hover {
		background: rgba(239, 68, 68, 0.5);
	}

	.action.cancel:hover {
		background: rgba(250, 162, 202, 0.22);
		color: #ffd2e4;
	}

	/* Retry sits on the red failed chip; lighten it so it reads as the action. */
	.action.retry {
		background: rgba(255, 255, 255, 0.16);
		color: #fff;
	}

	.action.retry:hover {
		background: rgba(255, 255, 255, 0.28);
	}

	@media (prefers-reduced-motion: reduce) {
		.bar {
			transition: none;
		}
	}
</style>
