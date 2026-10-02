<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import SquareIcon from '@lucide/svelte/icons/square';
	import studioMicrophone from '$lib/assets/studio-microphone.png';
	import type { Library } from '$lib/library.svelte.js';
	import RecorderClock from './RecorderClock.svelte';

	/**
	 * The home page's recorder: the microphone is the control that starts and
	 * stops, with one line under it for what is happening. Fixture mode adds
	 * its warning; nothing else sits under the recorder.
	 */
	let { library }: { library: Library } = $props();

	const recorder = $derived(library.recorder);
	const device = $derived(library.workspace.capture);
	const active = $derived(recorder.phase === 'recording');
	const pending = $derived(recorder.phase === 'starting' || recorder.phase === 'stopping');
	const label = $derived(
		{ idle: 'Start recording', starting: 'Starting…', recording: 'Stop recording', stopping: 'Finishing…' }[recorder.phase],
	);

	// The button is disabled while pending, which drops keyboard focus to the
	// page. Give it back when the press came from the focused microphone.
	let mic = $state<HTMLElement | null>(null);
	let returnFocus = false;
	function toggle() {
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
