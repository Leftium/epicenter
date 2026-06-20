<script lang="ts">
	import type { Snippet } from 'svelte';

	// Single source of the macOS Accessibility remove/re-add instructions: a
	// screen recording plus the written steps, embedded in the global
	// `MacosAccessibilityGuideDialog`. Kept as one component so any surface can
	// embed the same instructions instead of restating them.
	//
	// The video streams from the GitHub release `_assets` rather than shipping in
	// the app: keeping a multi-MB binary out of the bundle (and out of git) is
	// worth more than the offline demo, because the WRITTEN STEPS below are the
	// real source of truth and render with no network. The video is enhancement
	// only; if it can't load, the steps still carry the user through.
	const GUIDE_VIDEO_URL =
		'https://github.com/EpicenterHQ/epicenter/releases/download/_assets/macos_enable_accessibility.mp4';
</script>

<div class="flex flex-col gap-5">
	<video
		class="bg-muted aspect-video w-full rounded-lg border object-cover"
		src={GUIDE_VIDEO_URL}
		aria-label="macOS Accessibility walkthrough"
		loop
		controls
		muted
		playsinline
		autoplay
	>
		<p class="text-muted-foreground text-sm">
			Video guide not available. Please follow the written instructions below.
		</p>
	</video>
	<ol class="flex flex-col gap-3">
		{#snippet step(number: number, body: Snippet)}
			<li class="flex items-start gap-3">
				<span
					class="bg-muted text-foreground mt-px flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums"
					aria-hidden="true"
				>
					{number}
				</span>
				<span class="text-muted-foreground text-sm leading-relaxed">
					{@render body()}
				</span>
			</li>
		{/snippet}

		{@render step(1, goToAccessibility)}
		{@render step(2, removeWhispering)}
		{@render step(3, readdWhispering)}
	</ol>
</div>

{#snippet term(text: string)}
	<span class="text-foreground font-medium">{text}</span>
{/snippet}

{#snippet key(symbol: string)}
	<kbd
		class="bg-background text-foreground inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 align-text-bottom font-mono text-xs"
	>
		{symbol}
	</kbd>
{/snippet}

{#snippet goToAccessibility()}
	Go to {@render term('System Settings > Privacy & Security > Accessibility')}.
{/snippet}

{#snippet removeWhispering()}
	Click on {@render term('Whispering')} and remove it with the {@render key(
		'−',
	)} button.
{/snippet}

{#snippet readdWhispering()}
	Press the {@render key('+')} button and re-add {@render term(
		'Whispering.app',
	)}.
{/snippet}
