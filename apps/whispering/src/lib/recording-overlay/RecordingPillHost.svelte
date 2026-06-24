<script lang="ts">
	import { page } from '$app/state';
	import { tauri } from '#platform/tauri';
	import { dispatchPillAction } from '$lib/recording-overlay/pill-actions';
	import RecordingPill from '$lib/recording-overlay/RecordingPill.svelte';
	import { projectLifecycleToStatus } from '$lib/recording-overlay/projection';
	import { webPillLevel } from '$lib/recording-overlay/web-pill.svelte';
	import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

	// The web mount of the shared dictation pill. On desktop the pill is a native
	// overlay window, so this host renders nothing there; on web it places the
	// same `RecordingPill` as a fixed bottom-center element and drives it straight
	// from the lifecycle value, routing gestures through `pill-actions` (no IPC).
	// The pill body has no reveal action on web: the app window is already in
	// front, and a failure is surfaced by the notification and the recordings row.
	const status = $derived(projectLifecycleToStatus(dictationLifecycle.current));

	// The home route's recording card carries its own live meter and stop/cancel,
	// so the floating pill would only double it there. Yield the recording phase to
	// the card on '/', but keep the pill for the outcome phases (transcribing,
	// delivered, failed) the card never shows, and for every phase on the other app
	// routes (recordings, settings, ...), which have no in-window capture card.
	const isHomeRoute = $derived(page.url.pathname === '/');
	const showPill = $derived(
		!!status && !(isHomeRoute && status.phase === 'recording'),
	);
</script>

{#if !tauri && showPill}
	<!-- Bottom-center, matching the desktop overlay's resting position
	     (OVERLAY_BOTTOM_MARGIN). Above page content, below modals and toasts. -->
	<div class="fixed bottom-[72px] left-1/2 z-50 -translate-x-1/2">
		<RecordingPill
			{status}
			level={webPillLevel.level}
			onStop={() => dispatchPillAction('stop')}
			onCancel={() => dispatchPillAction('cancel')}
		/>
	</div>
{/if}
