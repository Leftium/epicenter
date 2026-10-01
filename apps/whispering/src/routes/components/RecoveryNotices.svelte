<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Spinner } from '@epicenter/ui/spinner';
	import type { Library, PendingRecording, TransformationRun } from '$lib/library.svelte.js';
	import AudioPlayer from './AudioPlayer.svelte';
	import { copyText, recordingTitle } from './file-actions.js';

	/**
	 * Everything held only in this window that needs the person: captured audio
	 * that is not in the folder, a transcript or transformation result whose file
	 * was not written, and requests still running or failed. It sits under the
	 * header on every page, so recovery never depends on which page is open and
	 * no list filter can hide it.
	 */
	let { library, onOpenRecording }: {
		library: Library;
		onOpenRecording: (path: string) => void;
	} = $props();

	const unsavedTranscripts = $derived(
		library.unsavedTranscripts.map((id) => ({
			id,
			entry: library.entries.find((entry) => entry.stem === id),
		})),
	);
	const runs = $derived(library.transformationRuns);
	const any = $derived(library.pending.length > 0 || unsavedTranscripts.length > 0 || runs.length > 0);

	function pendingHeadline(item: PendingRecording) {
		switch (item.state.kind) {
			case 'saving':
				return 'Saving the recording…';
			case 'partial':
				return 'The audio file is saved, but the recording’s file is not.';
			case 'unexpected':
				return 'Not saved: another file is in this recording’s place.';
			case 'failed':
				return 'Not saved. Nothing was written to the folder.';
		}
	}

	function discardPending(item: PendingRecording) {
		confirmationDialog.open({
			title: 'Discard this recording?',
			description:
				item.state.kind === 'partial'
					? `The audio held in this window is dropped. ${item.state.landed.join(', ')} stays in the folder without a recording file.`
					: 'The audio held in this window is dropped. It cannot be recovered.',
			confirm: { text: 'Discard', variant: 'destructive' },
			onConfirm: () => library.discardPending(item.capture.id),
		});
	}

	function discardTranscript(id: string) {
		confirmationDialog.open({
			title: 'Discard this transcript?',
			description: 'The text held in this window is dropped. Transcribing again sends the audio to the endpoint again.',
			confirm: { text: 'Discard', variant: 'destructive' },
			onConfirm: () => library.dismissRun(id),
		});
	}

	function discardRun(run: TransformationRun) {
		if (run.state.kind !== 'unsaved') {
			library.discardTransformationRun(run.id);
			return;
		}
		confirmationDialog.open({
			title: 'Discard this result?',
			description: 'The text held in this window is dropped. Running the transformation again calls the endpoint again.',
			confirm: { text: 'Discard', variant: 'destructive' },
			onConfirm: () => library.discardTransformationRun(run.id),
		});
	}
</script>

{#if any}
	<section class="max-h-64 shrink-0 overflow-y-auto border-b bg-destructive/5 text-sm" aria-label="Not saved yet" data-testid="recovery">
		<ul class="divide-y">
			{#each library.pending as item (item.capture.id)}
				<li class="flex flex-col gap-2 px-3 py-3 sm:px-4" data-testid="pending-recording" data-pending-state={item.state.kind}>
					<div class="flex items-center gap-2">
						{#if item.state.kind === 'saving'}<Spinner class="size-3.5" />{/if}
						<span class="font-medium">{pendingHeadline(item)}</span>
					</div>
					{#if item.state.kind !== 'saving'}
						<p class="text-xs text-muted-foreground" role="alert">{item.state.message}</p>
						<p class="text-xs text-muted-foreground">
							The audio is kept in this window as <code class="font-mono">{item.capture.id}</code>
							({item.capture.bytes.byteLength.toLocaleString()} bytes, attempt {item.attempts}). Trying again keeps this ID
							and never creates a second recording.
						</p>
						<AudioPlayer source={{ kind: 'bytes', bytes: item.capture.bytes, mimeType: item.mimeType }} label="Recording that is not saved yet" />
						<div class="flex items-center gap-2">
							<Button size="sm" onclick={() => void library.retryPending(item.capture.id)} data-testid="retry-pending">Try again</Button>
							<Button size="sm" variant="ghost-destructive" onclick={() => discardPending(item)}>Discard</Button>
						</div>
					{/if}
				</li>
			{/each}

			{#each unsavedTranscripts as { id, entry } (id)}
				{@const run = library.transcriptionRun(id)}
				{#if run?.kind === 'unsaved'}
					<li class="flex flex-col gap-2 px-3 py-3 sm:px-4" data-testid="unsaved-transcript">
						<p class="font-medium">
							The transcript of {entry ? `“${recordingTitle(entry)}”` : id} arrived, but its file was not saved.
						</p>
						<p class="text-xs text-muted-foreground" role="alert">{run.message}</p>
						<p class="max-h-24 overflow-y-auto rounded border bg-background p-2 whitespace-pre-wrap">{run.text}</p>
						<div class="flex items-center gap-2">
							<Button size="sm" onclick={() => void library.retrySaveResult(id)} data-testid="retry-transcript">Save it again</Button>
							<Button size="sm" variant="outline" onclick={() => void copyText(run.text, 'the transcript')}>Copy</Button>
							{#if entry}
								<Button size="sm" variant="ghost" onclick={() => onOpenRecording(entry.path)}>Open the recording</Button>
							{/if}
							<Button size="sm" variant="ghost-destructive" onclick={() => discardTranscript(id)} data-testid="discard-transcript">Discard</Button>
						</div>
					</li>
				{/if}
			{/each}

			{#each runs as run (run.id)}
				<li class="flex flex-col gap-2 px-3 py-3 sm:px-4" data-testid="transformation-run" data-run-state={run.state.kind}>
					{#if run.state.kind === 'running'}
						<p class="flex items-center gap-2 font-medium">
							<Spinner class="size-3.5" /> Running “{run.fields.transformationTitle}”…
						</p>
					{:else if run.state.kind === 'failed'}
						<p class="font-medium">“{run.fields.transformationTitle}” did not run. The transcript is unchanged.</p>
						<p class="text-xs text-muted-foreground" role="alert" data-testid="transformation-error">{run.state.message}</p>
						<div class="flex items-center gap-2">
							<Button size="sm" onclick={() => void library.retryTransformation(run.id)} data-testid="retry-transformation">Try again</Button>
							<Button size="sm" variant="ghost" onclick={() => discardRun(run)}>Dismiss</Button>
						</div>
					{:else}
						{@const text = run.state.text}
						<p class="font-medium">The result of “{run.fields.transformationTitle}” arrived, but its file was not saved.</p>
						<p class="text-xs text-muted-foreground" role="alert">{run.state.message}</p>
						<p class="max-h-24 overflow-y-auto rounded border bg-background p-2 whitespace-pre-wrap">{text}</p>
						<p class="text-xs text-muted-foreground">
							Saving again writes <code class="font-mono">transformation_runs/{run.id}.md</code> and does not call the endpoint again.
						</p>
						<div class="flex items-center gap-2">
							<Button size="sm" onclick={() => void library.retryTransformation(run.id)} data-testid="retry-transformation-save">Save it again</Button>
							<Button size="sm" variant="outline" onclick={() => void copyText(text, 'the result')}>Copy</Button>
							<Button size="sm" variant="ghost-destructive" onclick={() => discardRun(run)}>Discard</Button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}
