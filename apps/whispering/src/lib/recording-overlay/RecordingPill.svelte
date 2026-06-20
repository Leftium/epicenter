<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import CheckIcon from '@lucide/svelte/icons/check';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import XIcon from '@lucide/svelte/icons/x';
	import type { DeliveryReach } from '$lib/operations/delivery';
	import {
		FAILURE_LABEL,
		type RecordingOverlayStatus,
	} from '$lib/recording-overlay/events';

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
		onReveal,
	}: {
		/** What to display, or `null` when the dictation is idle (hidden). */
		status: RecordingOverlayStatus | null;
		/** Live, smoothed mic loudness, 0 (silent) to 1 (loud). */
		level: number;
		/** Stop the live capture (stop recording / stop listening). */
		onStop: () => void;
		/** Discard the live manual recording. */
		onCancel: () => void;
		/** Reveal Whispering by raising the main window (desktop). Omitted on web,
		 * where the app window is already in front. */
		onReveal?: () => void;
	} = $props();

	const isManual = $derived(
		status?.phase === 'recording' && status.trigger === 'manual',
	);
	const isSpeaking = $derived(
		status?.phase === 'recording' &&
			status.trigger === 'vad' &&
			status.vadState === 'SPEECH_DETECTED',
	);
	// The secondary pip riding beside a live VAD meter, or undefined when none
	// rides (manual recording, or a VAD session at rest).
	const vadPip = $derived(
		status?.phase === 'recording' && status.trigger === 'vad'
			? status.pip
			: undefined,
	);

	// Every non-recording phase is a "chip": one icon plus a short, fixed label,
	// with a tone that tints the icon (and, when failed, the whole pill). They
	// render through one block below instead of a branch apiece. The label is
	// always a closed, glanceable token, never a raw error message, so it fits the
	// fixed-width pill without truncation; the full failure detail lives in the OS
	// notification and the recordings row (ADR-0039).
	type ChipTone = 'neutral' | 'success' | 'degraded' | 'failed';
	type Chip = {
		Icon: typeof CheckIcon;
		label: string;
		tone: ChipTone;
		spin?: boolean;
	};

	// A delivery is a success at both reaches: a clean `output` reads green; the
	// `clipboard` fallback reads amber, "landed, but not where you asked".
	const DELIVERED_CHIP = {
		output: { Icon: CheckIcon, label: 'Delivered', tone: 'success' },
		clipboard: {
			Icon: CheckIcon,
			label: 'Copied to clipboard',
			tone: 'degraded',
		},
	} as const satisfies Record<DeliveryReach, Chip>;

	const chip = $derived.by((): Chip | null => {
		if (!status || status.phase === 'recording') return null;
		switch (status.phase) {
			case 'transcribing':
				return {
					Icon: LoaderCircleIcon,
					label: 'Transcribing',
					tone: 'neutral',
					spin: true,
				};
			case 'delivered':
				return DELIVERED_CHIP[status.reach];
			case 'failed':
				return {
					Icon: TriangleAlertIcon,
					label: FAILURE_LABEL[status.tier],
					tone: 'failed',
				};
		}
	});

	// Per-bar height envelope (taller in the middle) scaled by `level`. Reacting
	// the same amplitude through a fixed shape reads as a meter, not a flat block.
	const BAR_ENVELOPE = [0.5, 0.72, 0.9, 1, 0.9, 0.72, 0.5];
	const MIN_BAR_PX = 3;
	const MAX_BAR_PX = 18;

	function barHeight(envelope: number): number {
		return MIN_BAR_PX + envelope * level * (MAX_BAR_PX - MIN_BAR_PX);
	}

	// Resting state is a filled chip, not a bare icon, so the controls read as
	// buttons at a glance in the small pill. Each control composes its own tone over
	// this shared base. Per-property durations: colors glide at 150ms, the press
	// scale snaps at 100ms.
	const actionBase =
		'flex size-6 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white/92 [transition:background-color_150ms_ease-out,color_150ms_ease-out,transform_100ms_ease-out] hover:scale-[1.08] active:scale-95';

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
</script>

<!-- The pill is non-focusable on desktop (an overlay window) and decorative on
     web, so it can never receive keyboard focus; clicking its body (not a
     button) just brings the main window forward. Keyboard handlers are moot
     here, hence the a11y ignores. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
{#if status}
	<div
		class={cn(
			// The pill hugs its content and is centered within its mount (the desktop
			// overlay window centers it; the web host translates it to center), so each
			// state is a snug chip with no dead space leaving the meter off-center. The
			// mount centers a fixed 40px-tall, up-to-184px-wide pill; max-w-[184px] caps
			// it to that window so a long failed reason ellipsizes rather than overflowing.
			'box-border flex h-10 w-fit max-w-[184px] items-center gap-2 rounded-full px-2.5 text-white/92 shadow-[0_6px_20px_rgba(0,0,0,0.35)] backdrop-blur-[12px] select-none',
			// Failed: a red chip so the failure reads at a glance, with the terse reason
			// in the label. No action: detail and retry live on the recordings row.
			chip?.tone === 'failed'
				? 'border border-red-500/55 bg-[#3c1216]/92'
				: 'border border-white/8 bg-[#0f0f11]/82',
			// Clickable only where it can reveal the main window: desktop, where onReveal
			// is wired. On web the app window is already in front, so onReveal is omitted
			// and the body shows no pointer or tooltip (the action buttons stop
			// propagation, so only the empty areas would have triggered it).
			onReveal && 'cursor-pointer',
		)}
		title={onReveal ? 'Open Whispering' : undefined}
		onclick={onReveal}
	>
		{#if status.phase === 'recording'}
			<div class="flex items-center text-white/85">
				{#if isManual}
					<MicIcon class="size-4" />
				{:else}
					<AudioLinesIcon class="size-4" />
				{/if}
			</div>

			<div class="flex h-5 items-center gap-[3px]" aria-hidden="true">
				{#each BAR_ENVELOPE as envelope, i (i)}
					<!-- Height is set inline from the live mic level; the transition glides
					     between samples (~20-30 Hz) so the meter looks continuous, and is
					     dropped under reduced motion. Speech detected (VAD) tints the bar so
					     the user sees it cross the threshold, on top of the height already
					     reacting to loudness. -->
					<span
						class={cn(
							'w-[3px] rounded-full bg-white/85 transition-[height] duration-[80ms] ease-linear motion-reduce:transition-none',
							isSpeaking && 'bg-[#ffe5ee]',
						)}
						style="height: {barHeight(envelope)}px"
					></span>
				{/each}
			</div>

			{#if !isManual}
				<!-- The VAD pip is the previous utterance's transcribe spinner riding
				     beside the live meter. It holds a fixed-width slot (the size-3.5 icon's
				     width) for the whole session, full or empty, so the pill does not
				     resize when the spinner appears or clears. Dimmed so it reads as
				     secondary to the meter. No success or failure state: success is the
				     landing text, failure goes to the notification and the recordings row.
				     Empty at rest. -->
				<div
					class="flex w-[14px] flex-none items-center justify-center text-white/50"
					title={vadPip === 'transcribing'
						? 'Transcribing previous phrase'
						: undefined}
				>
					{#if vadPip === 'transcribing'}
						<LoaderCircleIcon class="size-3.5 animate-spin" />
					{/if}
				</div>
			{/if}

			<div class="flex items-center gap-1">
				<!-- Stop is the primary action: a red chip so it reads as "stop recording". -->
				<button
					type="button"
					class={cn(actionBase, 'bg-red-500/28 text-white hover:bg-red-500/50')}
					aria-label={isManual ? 'Stop recording' : 'Stop listening'}
					title={isManual ? 'Stop recording' : 'Stop listening'}
					onclick={handleStop}
				>
					<SquareIcon class="size-3.5" />
				</button>
				{#if isManual}
					<button
						type="button"
						class={cn(actionBase, 'hover:bg-[#faa2ca]/22 hover:text-[#ffd2e4]')}
						aria-label="Cancel recording"
						title="Cancel recording"
						onclick={handleCancel}
					>
						<XIcon class="size-4" />
					</button>
				{/if}
			</div>
		{:else if chip}
			<!-- One chip block for every non-recording phase. A failure is glanceable
			     by design: the terse label, no action; detail and retry live on the
			     recordings row (ADR-0039). -->
			{@const Icon = chip.Icon}
			<div
				class={cn(
					'flex items-center text-white/85',
					// A clean delivery reads green; a reduced reach (clipboard/history)
					// reads amber, "landed, but not where you asked" rather than a clean
					// success; a failure reads red, paired with the red pill background.
					chip.tone === 'success' && 'text-[#7ee2a8]',
					chip.tone === 'degraded' && 'text-[#f5c97b]',
					chip.tone === 'failed' && 'text-[#ffb4b4]',
				)}
			>
				<Icon class="size-4 {chip.spin ? 'animate-spin' : ''}" />
			</div>
			<!-- The label takes only its text's width in the snug chip. Labels are
			     closed, short tokens that fit the fixed-width pill; truncate's ellipsis
			     is a safety net, not load-bearing truncation. The full failure detail
			     lives in the OS notification and the recordings row, never here. -->
			<span class="min-w-0 flex-1 truncate text-[13px] font-medium"
				>{chip.label}</span
			>
		{/if}
	</div>
{/if}
