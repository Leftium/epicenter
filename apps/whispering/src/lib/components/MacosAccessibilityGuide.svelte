<script lang="ts">
	import type { Snippet } from 'svelte';

	// Single source of the macOS Accessibility instructions: a screen recording
	// plus the written steps, embedded in the global `MacosAccessibilityGuideDialog`.
	// Kept as one component so any surface can embed the same instructions instead
	// of restating them.
	//
	// The steps branch on `variant` because the two situations need genuinely
	// different actions, and showing the wrong one is worse than terse:
	//   - `first-grant` (never granted): `openSystemSettings` already adds Whispering
	//     to the list toggled off, so the whole job is flipping its switch. Telling a
	//     brand-new user to "remove Whispering" is impossible: it isn't there yet.
	//   - `re-add` (stale grant after an app update): the toggle reads on but the tap
	//     is dead, and only a remove-and-re-add clears it.
	// Neither variant repeats "navigate to Accessibility": the dialog's Open System
	// Settings button deep-links there, so the steps describe what to do once you land.
	//
	// The video streams from the GitHub release `_assets` rather than shipping in
	// the app: keeping a multi-MB binary out of the bundle (and out of git) is
	// worth more than the offline demo, because the WRITTEN STEPS below are the
	// real source of truth and render with no network. The video is enhancement
	// only; if it can't load, the steps still carry the user through.
	let { variant }: { variant: 'first-grant' | 're-add' } = $props();

	// The asset MUST be encoded with a leading `moov` atom (faststart) or the
	// browser buffers the whole file before showing a frame and the box just sits
	// black: `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`. The recording
	// is ~1028x1080 (near square), so it's centered at its native ratio rather than
	// cropped into a 16:9 box.
	const GUIDE_VIDEO_URL =
		'https://github.com/EpicenterHQ/epicenter/releases/download/_assets/macos_enable_accessibility.mp4';

	// The video is the enhancement; the steps are the truth. If the stream fails
	// (offline, host hiccup) say so plainly instead of leaving a dead black box
	// that reads as a broken app.
	let videoFailed = $state(false);
</script>

<div class="flex flex-col gap-5">
	{#if videoFailed}
		<div
			class="bg-muted/40 text-muted-foreground flex min-h-32 flex-col items-center justify-center gap-1 rounded-lg border px-4 py-6 text-center text-sm"
		>
			<span class="text-foreground font-medium">Couldn't load the demo</span>
			<span>The steps below are all you need.</span>
		</div>
	{:else}
		<video
			class="bg-muted mx-auto block max-h-80 rounded-lg border"
			src={GUIDE_VIDEO_URL}
			aria-label="macOS Accessibility walkthrough"
			loop
			controls
			muted
			playsinline
			autoplay
			onerror={() => (videoFailed = true)}
		>
		</video>
	{/if}
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

		{#if variant === 're-add'}
			{@render step(1, removeWhispering)}
			{@render step(2, readdWhispering)}
		{:else}
			{@render step(1, findWhispering)}
			{@render step(2, switchOn)}
		{/if}
	</ol>
</div>

{#snippet term(text: string)}
	<span class="text-foreground font-medium">{text}</span>
{/snippet}

{#snippet control(symbol: string)}
	<!-- A clicked on-screen button in System Settings, not a keystroke, so a chip
	     rather than <kbd>. -->
	<span
		class="bg-muted text-foreground inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 align-text-bottom text-xs font-medium"
	>
		{symbol}
	</span>
{/snippet}

{#snippet findWhispering()}
	Find {@render term('Whispering')} in the list (we added it for you).
{/snippet}

{#snippet switchOn()}
	Switch it {@render term('on')}.
{/snippet}

{#snippet removeWhispering()}
	Click {@render term('Whispering')}, then remove it with the {@render control(
		'−',
	)} button.
{/snippet}

{#snippet readdWhispering()}
	Press the {@render control('+')} button and re-add {@render term(
		'Whispering.app',
	)}.
{/snippet}
