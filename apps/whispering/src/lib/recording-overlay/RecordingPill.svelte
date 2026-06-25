<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import CheckIcon from '@lucide/svelte/icons/check';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import XIcon from '@lucide/svelte/icons/x';
	import LevelMeter from '$lib/components/LevelMeter.svelte';
	import type { DeliveryReach } from '$lib/operations/delivery';
	import {
		FAILURE_LABEL,
		type RecordingOverlayStatus,
	} from '$lib/recording-overlay/events';
	import { readLiveMeter } from '$lib/recording-overlay/live-meter';
	import VadIndicator from '$lib/recording-overlay/VadIndicator.svelte';

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

	// The live meter's secondary signals (mode, speech-latched, the transcribe
	// pip), read through the one helper the home capture card also uses so both
	// surfaces speak one visual language from one source.
	const display = $derived(readLiveMeter(status));

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

	// Resting state is a filled chip, not a bare icon, so the controls read as
	// buttons at a glance in the small pill. Each control composes its own tone over
	// this shared base, which carries the hover/press feedback: background and
	// press-scale glide together at 150ms.
	const actionBase =
		'flex size-6 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white/90 transition duration-150 ease-out hover:scale-[1.08] active:scale-95';

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
			// 40px-tall pill, shared look. gap-2.5 spaces the chip icon from its label;
			// in recording it is only the floor (justify-between distributes wider). The
			// width differs by phase (next arg).
			'box-border flex h-10 items-center gap-2.5 rounded-full px-2.5 text-white/90 shadow-[0_6px_20px_rgba(0,0,0,0.35)] backdrop-blur-md select-none',
			// Recording is a wider bar: the mic pins the left edge and stop the right,
			// with the meter spread between them (justify-between). The text chips hug
			// their content, capped wide enough for the longest label ("Transcription
			// failed") to show in full. The 224px cap is mirrored by the desktop overlay
			// window (OVERLAY_WIDTH in overlay.rs / index.tauri.ts), which must stay in sync.
			status.phase === 'recording'
				? 'w-[208px] justify-between'
				: 'w-fit max-w-[224px]',
			// Failed: a red chip so the failure reads at a glance, with the terse reason
			// in the label. No action: detail and retry live on the recordings row.
			chip?.tone === 'failed'
				? 'border border-red-500/55 bg-[#3c1216]/90'
				: 'border border-white/10 bg-[#0f0f11]/80',
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
			<div class="flex items-center text-white/80">
				{#if display.isManual}
					<MicIcon class="size-4" />
				{:else}
					<AudioLinesIcon class="size-4" />
				{/if}
			</div>

			<!-- Speech detected (VAD) tints the bars so the user sees capture cross the
			     threshold, on top of the height already reacting to loudness. -->
			<LevelMeter
				{level}
				class="h-5"
				barClass={display.isSpeaking ? 'bg-[#ffe5ee]' : undefined}
			/>

			<!-- Trailing cluster: a contextual slot, then stop as the constant right
			     anchor. Manual and VAD share this skeleton (slot then stop), so the
			     meter and the stop button land in the same place in both modes and only
			     the slot's content differs. The slot is always the cancel button's
			     width, so the cluster reads as balanced and the pill keeps a steady
			     width as the slot's content changes. -->
			<div class="flex items-center gap-1">
				{#if display.isManual}
					<!-- Manual can discard the take, so the slot is the cancel button. -->
					<button
						type="button"
						class={cn(actionBase, 'hover:bg-[#faa2ca]/20 hover:text-[#ffd2e4]')}
						aria-label="Cancel recording"
						title="Cancel recording"
						onclick={handleCancel}
					>
						<XIcon class="size-4" />
					</button>
				{:else}
					<!-- VAD has no per-utterance cancel, so the slot holds the capture
					     indicator at the cancel button's width, keeping the cluster
					     balanced. The same dim-dot -> lit-dot -> spinner the home capture
					     card shows: the bars track raw level, this mark tracks whether VAD
					     has latched onto speech (with its detection delay) and then the
					     previous phrase's transcribe. -->
					<div class="flex size-6 items-center justify-center">
						<VadIndicator
							speaking={display.isSpeaking}
							pip={display.vadPip}
							dimClass="bg-white/40"
							litClass="bg-pink-300"
							spinnerClass="text-white/50"
						/>
					</div>
				{/if}

				<!-- Stop: the primary action and the constant right anchor. A red chip so
				     it reads as "stop recording". -->
				<button
					type="button"
					class={cn(actionBase, 'bg-red-500/60 text-white hover:bg-red-500/80')}
					aria-label={display.isManual ? 'Stop recording' : 'Stop listening'}
					title={display.isManual ? 'Stop recording' : 'Stop listening'}
					onclick={handleStop}
				>
					<SquareIcon class="size-3.5" />
				</button>
			</div>
		{:else if chip}
			<!-- One chip block for every non-recording phase. A failure is glanceable
			     by design: the terse label, no action; detail and retry live on the
			     recordings row (ADR-0039). -->
			{@const Icon = chip.Icon}
			<div
				class={cn(
					'flex items-center text-white/80',
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
			<span class="min-w-0 truncate text-[13px] font-medium">{chip.label}</span>
		{/if}
	</div>
{/if}
