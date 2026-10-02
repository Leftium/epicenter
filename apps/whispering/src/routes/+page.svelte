<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Spinner } from '@epicenter/ui/spinner';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { audioPathIn } from '$lib/definition.js';
	import { getSession } from '$lib/session.svelte.js';
	import AudioPlayer from './components/AudioPlayer.svelte';
	import { copyText, formatTime, recordingTitle } from './components/file-actions.js';
	import RecorderCard from './components/RecorderCard.svelte';

	const { library, view } = getSession();

	/** The newest saved recording. A capture still being saved is in the notice under the header. */
	const latest = $derived(library.entries[0]);
	/** The audio the newest row names. Nothing is guessed from another file's name. */
	const audioPath = $derived(latest ? audioPathIn(latest.fields) : undefined);
	const transcript = $derived(latest ? library.resultsFor(latest.stem)[0] : undefined);
	const run = $derived(latest ? library.transcriptionRun(latest.stem) : undefined);
	const model = $derived(library.settings.transcriptionModel);

	async function openLatest() {
		if (latest === undefined) return;
		await library.open(latest.path);
		view.showingDetail = true;
		await goto(resolve('/recordings'));
	}
</script>

<svelte:head><title>Whispering</title></svelte:head>

<!-- The spacers hold the recorder just above the middle while there is room. A long latest recording takes that room, then the page scrolls. -->
<div class="mx-auto flex w-full max-w-xl flex-1 flex-col items-center px-4 py-8">
	<div class="flex-2"></div>
	<div class="flex flex-col items-center gap-4">
		<SectionHeader.Root class="space-y-3 text-center">
			<SectionHeader.Title level={1} class="text-4xl font-extrabold tracking-tight sm:text-5xl">Whispering</SectionHeader.Title>
			<SectionHeader.Description class="text-base">Record now. Turn it into text when you’re ready.</SectionHeader.Description>
		</SectionHeader.Root>

		<RecorderCard {library} />
	</div>

	<div class="w-full flex-3">
		{#if latest}
			<section class="mt-8 flex flex-col gap-2 border-t pt-5" aria-label="Latest recording" data-testid="latest-recording">
				<div class="flex items-center gap-2 text-sm">
					<h2 class="min-w-0 flex-1 truncate font-medium">{recordingTitle(latest)}</h2>
					{#if latest.issues}<Badge variant="destructive">Needs repair</Badge>{/if}
					{#if latest.fields.capture === 'fixture'}<Badge variant="outline">Fixture</Badge>{/if}
					<span class="shrink-0 text-xs text-muted-foreground max-sm:hidden">{formatTime(latest.fields.recordedAt, 'short')}</span>
				</div>

				{#if transcript}
					<div class="flex items-start gap-2 rounded-md border p-3 text-sm">
						<p class="max-h-40 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap" data-testid="latest-transcript">
							{transcript.body?.trim() || '(empty transcript)'}
						</p>
						<Button size="xs" variant="outline" onclick={() => void copyText(transcript.body ?? '', 'the transcript')} data-testid="copy-latest">
							Copy
						</Button>
					</div>
				{:else if run?.kind === 'failed'}
					<p class="text-sm text-destructive" role="alert" data-testid="transcription-error">{run.message}</p>
				{:else if audioPath && run?.kind !== 'unsaved'}
					<p class="text-sm text-muted-foreground">
						{#if run?.kind === 'running'}
							Transcribing…
						{:else if model}
							Not transcribed yet. Nothing is sent until you press Transcribe.
						{:else}
							No transcription model is set. Add one in Settings.
						{/if}
					</p>
				{/if}

				<!-- On a narrow window the player takes its own line, so its scrubber and duration stay visible. -->
				<div class="flex flex-wrap items-center gap-2">
					{#if audioPath}
						<div class="min-w-0 flex-1 basis-full sm:basis-0">
							<AudioPlayer
								source={{ kind: 'file', files: library.folder.files, path: audioPath, generation: library.generation }}
								label="Audio of {recordingTitle(latest)}"
							/>
						</div>
					{:else}
						<p class="flex-1 basis-full text-sm text-muted-foreground sm:basis-0">This recording’s file names no audio, so it cannot be played or transcribed. Open it to add the path.</p>
					{/if}
					{#if !transcript && run?.kind !== 'unsaved'}
						<Button
							size="sm"
							tooltip={model ? `Transcribes with ${model}` : undefined}
							disabled={audioPath === undefined || run?.kind === 'running'}
							onclick={() => void library.transcribe(latest)}
							data-testid="transcribe-latest"
						>
							{#if run?.kind === 'running'}<Spinner class="size-3.5" />{/if}
							{run?.kind === 'failed' ? 'Try again' : 'Transcribe'}
						</Button>
					{/if}
					<Button size="sm" variant="outline" onclick={() => void openLatest()} data-testid="open-latest">Open</Button>
				</div>
			</section>
		{/if}
	</div>
</div>
