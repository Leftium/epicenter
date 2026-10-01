<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';
	import type { Library } from '$lib/library.svelte.js';
	import RecorderClock from './RecorderClock.svelte';

	/**
	 * The home page's recorder: one large control that starts and stops, with
	 * the elapsed time while it runs and what this session records from.
	 */
	let { library }: { library: Library } = $props();

	const recorder = $derived(library.recorder);
	const device = $derived(library.workspace.capture);
	const active = $derived(recorder.phase === 'recording');
	const pending = $derived(recorder.phase === 'starting' || recorder.phase === 'stopping');
	const label = $derived(
		{ idle: 'Start recording', starting: 'Starting…', recording: 'Stop recording', stopping: 'Finishing…' }[recorder.phase],
	);
</script>

<div class={cn('w-full overflow-hidden rounded-xl bg-card shadow-sm', active && 'ring-1 ring-destructive/25')}>
	<Button
		variant="ghost"
		class="h-auto min-h-24 w-full justify-start gap-4 rounded-none px-5 py-6 text-left hover:bg-transparent dark:hover:bg-transparent"
		aria-pressed={active}
		aria-busy={pending}
		disabled={pending}
		onclick={() => void (active ? library.stopRecording() : library.startRecording())}
		data-testid={active ? 'stop-recording' : 'start-recording'}
	>
		<span
			aria-hidden="true"
			class={cn(
				'flex size-14 shrink-0 items-center justify-center rounded-lg shadow-sm sm:size-16',
				active ? 'bg-destructive/10 text-destructive' : 'bg-primary text-primary-foreground',
			)}
		>
			{#if pending}
				<Spinner class="size-7" />
			{:else if active}
				<SquareIcon class="size-6 fill-current" />
			{:else}
				<MicIcon class="size-7" />
			{/if}
		</span>
		<span class="flex min-w-0 flex-1 flex-col gap-1">
			<span class="truncate text-base leading-none font-semibold sm:text-lg">{label}</span>
			<span class="truncate text-sm text-muted-foreground">
				{#if recorder.phase === 'recording'}
					Recording · <RecorderClock startedAt={recorder.startedAt} />
				{:else if recorder.phase === 'stopping'}
					Saving the audio to the folder
				{:else}
					Saved to the recordings folder when you stop
				{/if}
			</span>
		</span>
	</Button>
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-5 py-2 text-xs text-muted-foreground">
		{#if device.source === 'fixture'}
			<span class="text-warning" data-testid="fixture-notice">
				Fixture mode: recordings use {device.label}. The microphone is not used.
			</span>
		{:else}
			<span class="flex items-center gap-1.5"><MicIcon class="size-3.5" /> {device.label}</span>
		{/if}
		<span class="ml-auto truncate">
			Transcribes with {library.settings.transcriptionModel || 'no model set'} when you ask
		</span>
	</div>
</div>

{#if library.workspace.captureNotice}
	<p class="text-center text-sm text-warning" role="status" data-testid="capture-notice">{library.workspace.captureNotice}</p>
{/if}
{#if library.recorderError}
	<p class="text-center text-sm text-destructive" role="alert" data-testid="recorder-error">{library.recorderError}</p>
{/if}
