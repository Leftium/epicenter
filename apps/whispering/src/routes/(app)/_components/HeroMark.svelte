<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import RecordingMark from '$lib/components/icons/RecordingMark.svelte';

	// The brand mark made the recording signature: while a capture session is
	// live, a breathing ring and soft glow pulse in the recording red. The motion
	// rides a wrapper around the mark, not the mark itself, so it is independent
	// of the SVG art and adds no layout shift (everything pulsing is absolutely
	// positioned). Presentational only; the page owns what "live" means.
	let { live = false, class: className }: { live?: boolean; class?: string } =
		$props();
</script>

<span
	class={cn(
		'relative inline-flex',
		live ? 'text-destructive' : 'text-foreground',
		className,
	)}
>
	{#if live}
		<span class="glow" aria-hidden="true"></span>
		<span class="ring" aria-hidden="true"></span>
		<span class="ring ring-late" aria-hidden="true"></span>
	{/if}
	<RecordingMark class="relative size-full" />
</span>

<style>
	.glow {
		position: absolute;
		inset: -20%;
		border-radius: 9999px;
		background: radial-gradient(closest-side, currentColor, transparent);
		opacity: 0.2;
		animation: hero-mark-glow 2.4s ease-in-out infinite;
	}
	.ring {
		position: absolute;
		inset: 0;
		border-radius: 9999px;
		border: 2px solid currentColor;
		opacity: 0;
		animation: hero-mark-ring 2.4s ease-out infinite;
	}
	.ring-late {
		animation-delay: 1.2s;
	}

	@keyframes hero-mark-ring {
		0% {
			transform: scale(0.9);
			opacity: 0.55;
		}
		100% {
			transform: scale(1.9);
			opacity: 0;
		}
	}
	@keyframes hero-mark-glow {
		0%,
		100% {
			opacity: 0.12;
		}
		50% {
			opacity: 0.38;
		}
	}

	/* Reduced motion keeps the state change but drops the loop: a static halo
	   and the red mark still read as "recording", just without movement. */
	@media (prefers-reduced-motion: reduce) {
		.glow {
			animation: none;
			opacity: 0.28;
		}
		.ring {
			animation: none;
			opacity: 0.4;
			transform: scale(1.2);
		}
		.ring-late {
			display: none;
		}
	}
</style>
