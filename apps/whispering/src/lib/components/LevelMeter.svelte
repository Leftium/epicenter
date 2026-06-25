<script lang="ts">
	import { cn } from '@epicenter/ui/utils';

	// The live mic meter: a fixed bank of bars whose heights ride the smoothed
	// `level`. Shared by the floating recording pill and the in-window recording
	// card so both speak one visual language by construction, rather than keeping
	// two copies of the envelope and height math in sync by hand (ADR-0039). The
	// caller styles the bars (width, color) and the container (height, gap); the
	// defaults render the pill's 3px white bar.
	let {
		level,
		minPx = 3,
		maxPx = 18,
		barClass,
		class: className,
	}: {
		/** Smoothed mic loudness, 0 (silent) to 1 (loud). */
		level: number;
		/** Bar height floor (silent) and ceiling (loud), in px. */
		minPx?: number;
		maxPx?: number;
		/** Per-bar classes: width and color. */
		barClass?: string;
		/** Container classes: height and gap. */
		class?: string;
	} = $props();

	// Per-bar height envelope (taller in the middle) scaled by `level`. Reacting
	// the same amplitude through a fixed shape reads as a meter, not a flat block.
	const ENVELOPE = [
		0.35, 0.5, 0.68, 0.84, 0.95, 1, 0.95, 0.84, 0.68, 0.5, 0.35,
	];

	function barHeight(envelope: number): number {
		return minPx + envelope * level * (maxPx - minPx);
	}
</script>

<div class={cn('flex items-center gap-[3px]', className)} aria-hidden="true">
	{#each ENVELOPE as envelope, i (i)}
		<!-- Height is set inline from the live mic level; the transition glides
		     between samples (~20-30 Hz) so the meter looks continuous, and is
		     dropped under reduced motion. -->
		<span
			class={cn(
				'w-[3px] rounded-full bg-white/80 transition-[height] duration-[80ms] ease-linear motion-reduce:transition-none',
				barClass,
			)}
			style="height: {barHeight(envelope)}px"
		></span>
	{/each}
</div>
