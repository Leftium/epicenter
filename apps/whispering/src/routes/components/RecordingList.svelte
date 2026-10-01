<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Spinner } from '@epicenter/ui/spinner';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';
	import type { RecordingEntry } from '$lib/editor.svelte.js';
	import type { Library, PendingRecording } from '$lib/library.svelte.js';
	import { committedState } from '$lib/status.js';
	import AudioPlayer from './AudioPlayer.svelte';

	let { library, onOpen }: { library: Library; onOpen?: () => void } = $props();

	const device = $derived(library.workspace.capture);
	const recording = $derived(library.recorder.phase === 'recording');

	/** Elapsed seconds while recording, ticking only while a recording runs. */
	let elapsed = $state(0);
	$effect(() => {
		const state = library.recorder;
		if (state.phase !== 'recording') {
			elapsed = 0;
			return;
		}
		const tick = () => (elapsed = Math.floor((performance.now() - state.startedAt) / 1000));
		tick();
		const timer = setInterval(tick, 250);
		return () => clearInterval(timer);
	});
	const clock = $derived(
		`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`,
	);

	function titleOf(entry: RecordingEntry) {
		const title = entry.fields.title;
		if (typeof title === 'string' && title.trim() !== '') return title;
		return entry.stem ?? entry.path;
	}

	function when(entry: RecordingEntry) {
		const value = entry.fields.recordedAt;
		if (typeof value !== 'string') return '';
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	}

	function historyOf(entry: RecordingEntry) {
		return committedState(library.git, [entry.path, ...(entry.attachment ? [entry.attachment] : [])]);
	}

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

	function discard(item: PendingRecording) {
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
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Recordings">
	<div class="flex flex-col items-center gap-2 border-b p-4">
		{#if recording}
			<Button size="lg" variant="destructive" onclick={() => void library.stopRecording()} data-testid="stop-recording">
				<SquareIcon /> Stop · {clock}
			</Button>
		{:else}
			<Button
				size="lg"
				disabled={library.recorder.phase !== 'idle'}
				onclick={() => void library.startRecording()}
				data-testid="start-recording"
			>
				{#if library.recorder.phase === 'idle'}<MicIcon />{:else}<Spinner class="size-4" />{/if}
				{library.recorder.phase === 'stopping' ? 'Finishing…' : library.recorder.phase === 'starting' ? 'Starting…' : 'Record'}
			</Button>
		{/if}
		{#if device.source === 'fixture'}
			<p class="text-center text-xs text-warning" data-testid="fixture-notice">
				Fixture mode: recordings use {device.label}. The microphone is not used.
			</p>
		{:else}
			<p class="text-center text-xs text-muted-foreground">Records from the microphone into the recordings folder.</p>
		{/if}
		{#if library.workspace.captureNotice}
			<p class="text-center text-xs text-warning" role="status" data-testid="capture-notice">{library.workspace.captureNotice}</p>
		{/if}
		{#if library.recorderError}
			<p class="text-center text-xs text-destructive" role="alert" data-testid="recorder-error">{library.recorderError}</p>
		{/if}
	</div>

	{#if library.pending.length > 0}
		<ul class="border-b bg-destructive/5" aria-label="Recordings not saved yet">
			{#each library.pending as item (item.capture.id)}
				<li class="flex flex-col gap-2 border-b px-3 py-3 text-sm last:border-b-0" data-testid="pending-recording" data-pending-state={item.state.kind}>
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
							<Button size="sm" variant="ghost-destructive" onclick={() => discard(item)}>Discard</Button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if library.listError}
		<p class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive" role="status">
			Could not read the recordings folder: {library.listError}. Showing the last list that was read.
		</p>
	{/if}

	<ul class="min-h-0 flex-1 overflow-y-auto" aria-label="Saved recordings" data-testid="recording-list">
		{#each library.entries as entry (entry.path)}
			{@const selected = library.selectedPath === entry.path}
			{@const history = historyOf(entry)}
			{@const count = entry.stem ? library.resultsFor(entry.stem).length : 0}
			<li class="border-b text-sm {selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'}">
				<button
					type="button"
					class="flex w-full min-w-0 flex-col gap-0.5 px-3 py-2 text-left"
					aria-current={selected ? 'true' : undefined}
					data-recording={entry.path}
					onclick={() => {
						void library.open(entry.path);
						onOpen?.();
					}}
				>
					<span class="flex items-center gap-2">
						<span class="truncate font-medium">{titleOf(entry)}</span>
						{#if entry.issues}<Badge variant="destructive" class="shrink-0">Needs repair</Badge>{/if}
						{#if entry.fields.capture === 'fixture'}<Badge variant="outline" class="shrink-0">Fixture</Badge>{/if}
					</span>
					<span class="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
						<span>{when(entry) || entry.path}</span>
						{#if count > 0}<span>· {count} {count === 1 ? 'transcription' : 'transcriptions'}</span>{/if}
						{#if !entry.attachment && !entry.issues}<span>· no audio</span>{/if}
						{#if history === 'uncommitted'}<span data-testid="row-history">· saved, not in history yet</span>{/if}
					</span>
				</button>
			</li>
		{:else}
			<li class="px-3 py-8 text-center text-sm text-muted-foreground">
				No recordings yet. Press Record, or add
				<code class="font-mono">recordings/&lt;id&gt;.md</code> in the terminal.
			</li>
		{/each}
	</ul>

	{#if library.unreadable.length > 0}
		<div class="border-t bg-warning/10 px-3 py-2 text-xs">
			<p class="font-medium">Files that could not be read as text</p>
			<ul class="mt-1 space-y-0.5">
				{#each library.unreadable as item (item.path)}
					<li><code class="font-mono">{item.path}</code>: {item.message}</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>
