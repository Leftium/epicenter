<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Link } from '@epicenter/ui/link';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Spinner } from '@epicenter/ui/spinner';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import studioMicrophone from '$lib/assets/studio-microphone.png';
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

	async function openLatest() {
		if (latest === undefined) return;
		await library.open(latest.path);
		view.showingDetail = true;
		await goto(resolve('/recordings'));
	}
</script>

<svelte:head><title>Whispering</title></svelte:head>

<div class="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-start gap-5 px-4 py-8 sm:justify-center sm:py-12">
	<SectionHeader.Root class="flex flex-col items-center gap-2 text-center">
		<div class="flex items-center gap-2.5">
			<img src={studioMicrophone} alt="" class="size-8" />
			<SectionHeader.Title level={1} class="text-3xl">Whispering</SectionHeader.Title>
		</div>
		<SectionHeader.Description class="text-base">Record now. Turn it into text when you’re ready.</SectionHeader.Description>
	</SectionHeader.Root>

	<RecorderCard {library} />

	{#if latest}
		<section class="flex w-full flex-col gap-2" aria-label="Latest recording" data-testid="latest-recording">
			<div class="flex items-center gap-2 text-sm">
				<h2 class="truncate font-medium">{recordingTitle(latest)}</h2>
				{#if latest.issues}<Badge variant="destructive">Needs repair</Badge>{/if}
				{#if latest.fields.capture === 'fixture'}<Badge variant="outline">Fixture</Badge>{/if}
				<span class="ml-auto shrink-0 text-xs text-muted-foreground">{formatTime(latest.fields.recordedAt, 'short')}</span>
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
			{:else if run?.kind !== 'unsaved'}
				<p class="text-sm text-muted-foreground">
					{#if audioPath}
						Transcription uses the audio file this recording names. Nothing is sent anywhere until you ask for a transcript.
					{:else}
						Nothing can be sent for a transcript until this recording’s file names its audio.
					{/if}
				</p>
			{/if}

			<div class="flex w-full items-center gap-2">
				{#if audioPath}
					<div class="min-w-0 flex-1">
						<AudioPlayer
							source={{ kind: 'file', files: library.folder.files, path: audioPath, generation: library.generation }}
							label="Audio of {recordingTitle(latest)}"
						/>
					</div>
				{:else}
					<p class="flex-1 text-sm text-muted-foreground">This recording’s file names no audio. Open it to add the path.</p>
				{/if}
				{#if !transcript && run?.kind !== 'unsaved'}
					<Button
						size="sm"
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

	<p class="text-center text-sm text-muted-foreground">
		{#if library.entries.length > 0}
			<Link href={resolve('/recordings')}>
				{library.entries.length === 1 ? 'Your recording' : `All ${library.entries.length} recordings`}
			</Link>
			keep their audio, transcripts, and notes as files.
		{:else}
			Recordings, transcripts, and notes are saved as files you can open in
			<Link href={resolve('/recordings')}>Recordings</Link>.
		{/if}
		<Link href={resolve('/transformations')}>Transformations</Link> turn a transcript into a cleaned-up text, a summary, or an email.
	</p>
</div>
