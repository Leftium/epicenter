<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import SquareIcon from '@lucide/svelte/icons/square';
	import studioMicrophone from '$lib/assets/studio-microphone.png';
	import type { Library } from '$lib/library.svelte.js';
	import MicrophoneControl from './MicrophoneControl.svelte';
	import PostProcessingControl from './PostProcessingControl.svelte';
	import RecorderClock from './RecorderClock.svelte';
	import TranscriptionControl from './TranscriptionControl.svelte';

	/**
	 * The home page's recorder: the microphone is the control that starts and
	 * stops, with one line under it for what is happening. Three small controls
	 * sit at its lower-right on desktop and below the hint on narrow windows.
	 * Fixture mode adds its warning under them.
	 */
	let { library }: { library: Library } = $props();

	const recorder = $derived(library.recorder);
	const device = $derived(library.workspace.capture);
	const active = $derived(recorder.phase === 'recording');
	const pending = $derived(recorder.phase === 'starting' || recorder.phase === 'stopping');
	const label = $derived(
		{ idle: 'Start recording', starting: 'Starting…', recording: 'Stop recording', stopping: 'Finishing…' }[recorder.phase],
	);

	/**
	 * Which of the three option popovers is open. One value, so opening one
	 * closes the one before it: nothing is left open behind another, and the
	 * microphone popover's test or enabling ends when it stops being the one.
	 */
	type Option = 'microphone' | 'transcription' | 'post-processing';
	let openOption = $state<Option>();
	function setOpen(option: Option, open: boolean) {
		if (open) openOption = option;
		else if (openOption === option) openOption = undefined;
	}

	// The button is disabled while pending, which drops keyboard focus to the
	// page. Give it back when the press came from the focused microphone.
	let mic = $state<HTMLElement | null>(null);
	let returnFocus = false;
	function toggle() {
		openOption = undefined;
		returnFocus = document.activeElement === mic;
		void (active ? library.stopRecording() : library.startRecording());
	}
	$effect(() => {
		if (pending || !returnFocus) return;
		returnFocus = false;
		// Only when focus went nowhere: someone who moved elsewhere keeps their place.
		if (document.activeElement === document.body) mic?.focus({ preventScroll: true });
	});
</script>

<!-- Keep the microphone centered; its options do not add width to the recorder. -->
<div class="relative flex flex-col items-center gap-4">
	<!-- The button keeps one size in every phase, so nothing under it moves. -->
	<Button
		bind:ref={mic}
		variant="ghost"
		class="relative size-32 rounded-full p-0 hover:bg-transparent disabled:opacity-100 dark:hover:bg-transparent"
		aria-label={label}
		aria-pressed={active}
		aria-busy={pending}
		disabled={pending}
		onclick={toggle}
		data-testid={active ? 'stop-recording' : 'start-recording'}
	>
		{#if active}
			<span class="flex size-24 items-center justify-center rounded-full bg-destructive/10 text-destructive ring-1 ring-destructive/30">
				<SquareIcon class="size-9 fill-current" />
			</span>
		{:else}
			<!-- The image is 160px wide: at this size it is drawn 1.4 times its pixels on a 2x display, and no larger copy exists. -->
			<img
				src={studioMicrophone}
				alt=""
				draggable="false"
				class={cn(
					'size-28 drop-shadow-lg transition-transform group-hover/button:scale-105 group-active/button:scale-95 motion-reduce:transition-none',
					pending && 'opacity-40',
				)}
			/>
			{#if pending}<Spinner class="absolute size-8" />{/if}
		{/if}
	</Button>

	<p class="flex h-8 items-center gap-2 text-sm text-muted-foreground">
		{#if recorder.phase === 'recording'}
			<span class="size-2 rounded-full bg-destructive" aria-hidden="true"></span>
			<span class="text-2xl font-semibold text-foreground"><RecorderClock startedAt={recorder.startedAt} /></span>
		{:else if recorder.phase === 'starting'}
			Starting…
		{:else if recorder.phase === 'stopping'}
			Saving the audio…
		{:else}
			Click the microphone to start recording.
		{/if}
	</p>

	<!--
		The desktop row sits beside the microphone; narrow windows keep it below the hint.
		Each names itself and its current value in its label and tooltip, and opens its own popover, one at a time.
	-->
	<div class="flex items-center justify-center gap-1.5 md:absolute md:top-20 md:left-1/2 md:ml-3 md:translate-x-16" role="group" aria-label="Recording options">
		<MicrophoneControl bind:open={() => openOption === 'microphone', (open) => setOpen('microphone', open)} />
		<TranscriptionControl bind:open={() => openOption === 'transcription', (open) => setOpen('transcription', open)} />
		<PostProcessingControl bind:open={() => openOption === 'post-processing', (open) => setOpen('post-processing', open)} />
	</div>

</div>

<!-- Always mounted so the start of a recording is announced. The clock stays outside it: it changes every second. -->
<span class="sr-only" role="status">{active ? 'Recording' : ''}</span>

{#if device.source === 'fixture'}
	<p class="text-center text-xs text-balance text-warning" data-testid="fixture-notice">
		Fixture mode: recordings use {device.label}. The microphone is not used.
	</p>
{/if}

{#if library.workspace.captureNotice}
	<p class="text-center text-sm text-warning" role="status" data-testid="capture-notice">{library.workspace.captureNotice}</p>
{/if}
{#if library.recorderError}
	<p class="text-center text-sm text-destructive" role="alert" data-testid="recorder-error">{library.recorderError}</p>
{/if}
