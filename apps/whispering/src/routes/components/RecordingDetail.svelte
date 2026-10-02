<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Tabs from '@epicenter/ui/tabs';
	import { Textarea } from '@epicenter/ui/textarea';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import XIcon from '@lucide/svelte/icons/x';
	import { audioPathIn } from '$lib/definition.js';
	import { patchRow, type RecordingEditor, type RecordingEntry } from '$lib/editor.svelte.js';
	import { withFileNewlines } from '$lib/files.js';
	import type { Library } from '$lib/library.svelte.js';
	import { committedState } from '$lib/status.js';
	import AudioPlayer from './AudioPlayer.svelte';
	import { confirmDelete } from './file-actions.js';
	import SaveStatus from './SaveStatus.svelte';
	import TranscriptCard from './TranscriptCard.svelte';

	let {
		library,
		editor,
		entry,
		onBack,
		onClose,
	}: {
		library: Library;
		editor: RecordingEditor;
		/** The listed row, or undefined when the file left the folder. */
		entry: RecordingEntry | undefined;
		/** Shown on narrow windows, where the table and the details take turns. */
		onBack?: () => void;
		/** Shown on wide windows, where the details are a pane beside the table. */
		onClose?: () => void;
	} = $props();

	/**
	 * What is worked on comes first: the audio, then the transcript beside it,
	 * then notes. What describes the files (when, how long, where, which ID) is
	 * kept, one press away, under File details.
	 */

	/**
	 * How the draft reads, by the recordings table's own interpreter. Details
	 * and Source are two views of this one draft, and every message below
	 * describes the text on screen, saved or not, never the file as last saved.
	 */
	const draft = $derived(library.folder.tables.recordings.inspect(editor.buffer));
	const title = $derived(draft.fields.title ?? '');
	// A draft that does not parse has no fields or notes to edit; its source does.
	const fieldsEditable = $derived(draft.parseError === undefined);
	const id = $derived(editor.baseline.stem);
	const results = $derived(library.resultsFor(id));
	const run = $derived(library.transcriptionRun(id));
	/** The audio the saved row names. Nothing is guessed from another file's name. */
	const audioPath = $derived(entry ? audioPathIn(entry.fields) : undefined);
	const history = $derived(
		entry ? committedState(library.git, [entry.path, ...(audioPath ? [audioPath] : [])]) : undefined,
	);
	let tab = $state('details');

	function when(value: unknown) {
		if (typeof value !== 'string') return 'Unknown';
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
	}

	function seconds(value: unknown) {
		return typeof value === 'number' ? `${(value / 1000).toFixed(1)} s` : 'Unknown';
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Recording" data-testid="recording-detail">
	<div class="flex items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to recordings" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		<Input
			class="flex-1 text-base font-medium"
			value={title}
			placeholder="Title"
			aria-label="Recording title"
			disabled={!fieldsEditable}
			oninput={(event) => patchRow(editor, { fields: { title: event.currentTarget.value } })}
		/>
		{#if onClose}
			<Button variant="ghost" size="icon-sm" tooltip="Close details" aria-label="Close details" onclick={onClose} data-testid="close-detail">
				<XIcon />
			</Button>
		{/if}
	</div>

	<SaveStatus {editor} autosavePaused={library.autosave.paused} onDiscardRemoved={() => library.discardRemoved(editor.path)} />

	{#if draft.parseError}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs" data-testid="needs-repair">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				{draft.parseError.message}. Edit the source to fix it.
				{#if tab !== 'source'}
					<Button size="xs" variant="outline" onclick={() => (tab = 'source')}>Edit Source</Button>
				{/if}
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each draft.parseError.diagnostics as diagnostic, index (index)}
					{#if diagnostic.message !== draft.parseError.message}<li>{diagnostic.message}</li>{/if}
				{/each}
			</ul>
		</div>
	{:else if draft.issues.length > 0}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs" data-testid="needs-repair">
			<p class="mb-1 flex items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				Some fields need fixing in Source. The rest of the recording still works.
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each draft.issues as issue, index (index)}
					<li>{issue.message}</li>
				{/each}
			</ul>
		</div>
	{/if}

	<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
		<Tabs.List>
			<Tabs.Trigger value="details">Details</Tabs.Trigger>
			<Tabs.Trigger value="source">Source</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="details" class="min-h-0 flex-1 overflow-y-auto">
			<div class="flex flex-col gap-4 py-1">
				{#if audioPath}
					<AudioPlayer
						source={{ kind: 'file', files: library.folder.files, path: audioPath, generation: library.generation }}
						label="Audio of {title || id}"
					/>
				{:else}
					<p class="text-sm text-muted-foreground" data-testid="no-audio">
						This recording’s file names no audio: it has no <code class="font-mono">audioPath</code>. Add the audio
						file’s path in Source.
					</p>
				{/if}

				<div class="flex flex-col gap-2">
					<div class="flex items-center gap-2">
						<h3 class="text-sm font-medium">Transcription</h3>
						<Button
							class="ml-auto"
							size="sm"
							disabled={entry === undefined || audioPath === undefined || run?.kind === 'running' || run?.kind === 'unsaved'}
							onclick={() => entry && void library.transcribe(entry)}
							data-testid="transcribe"
						>
							{#if run?.kind === 'running'}<Spinner class="size-3.5" />{/if}
							{results.length > 0 ? 'Transcribe again' : 'Transcribe'}
						</Button>
					</div>
					{#if run?.kind === 'failed'}
						<p class="text-sm text-destructive" role="alert" data-testid="transcription-error">
							{run.message}
							<Button size="xs" variant="outline" class="ml-2" onclick={() => library.dismissRun(id)}>Dismiss</Button>
						</p>
					{:else if run?.kind === 'unsaved'}
						<div class="rounded border border-destructive/40 p-2 text-sm" role="alert">
							<p class="text-destructive">The transcript arrived, but its file is not confirmed as saved: {run.message}</p>
							<p class="my-2 whitespace-pre-wrap">{run.text}</p>
							<p class="mb-2 text-xs text-muted-foreground">
								Saving again writes <code class="font-mono">transcriptions/{run.id}.md</code>, or finds it there from an
								earlier attempt, and does not call the endpoint again. Nothing new is transcribed until this is saved, or
								discarded in the notice under the header.
							</p>
							<Button size="xs" disabled={run.saving} onclick={() => void library.retrySaveResult(id)}>
								{#if run.saving}<Spinner class="size-3" />{/if}
								Save it again
							</Button>
						</div>
					{/if}
					{#each results as result (result.path)}
						<TranscriptCard {library} {result} />
					{:else}
						{#if run === undefined}
							<p class="text-sm text-muted-foreground">No transcription yet.</p>
						{/if}
					{/each}
				</div>

				<div class="flex flex-col gap-1.5">
					<h3 class="text-sm font-medium">Notes</h3>
					<Textarea
						class="min-h-28 resize-y font-sans"
						value={draft.body ?? ''}
						placeholder="Notes in Markdown, saved in the recording’s file"
						aria-label="Notes"
						disabled={!fieldsEditable}
						oninput={(event) =>
							patchRow(editor, { body: withFileNewlines(event.currentTarget.value, draft.body ?? '') })}
					/>
				</div>

				<Collapsible.Root>
					<Collapsible.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="ghost" size="sm" class="group -ml-2 text-muted-foreground" data-testid="file-details">
								<ChevronRightIcon class="transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none" />
								File details
							</Button>
						{/snippet}
					</Collapsible.Trigger>
					<Collapsible.Content class="pt-2">
					<dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
						<dt class="text-muted-foreground">Recorded</dt>
						<dd>{when(draft.fields.recordedAt)}</dd>
						<dt class="text-muted-foreground">Length</dt>
						<dd>{seconds(draft.fields.durationMs)}</dd>
						<dt class="text-muted-foreground">Captured from</dt>
						<dd>
							{#if draft.fields.capture === 'fixture'}
								<Badge variant="outline">Fixture audio, not a microphone take</Badge>
							{:else if draft.fields.capture === 'microphone'}
								Microphone
							{:else}
								Unknown
							{/if}
						</dd>
						<dt class="text-muted-foreground">Transcribes with</dt>
						<dd class="min-w-0 break-words">{library.settings.transcriptionModel} at {library.settings.transcriptionBaseUrl}</dd>
						<dt class="text-muted-foreground">History</dt>
						<dd data-testid="recording-history">
							{history === 'uncommitted' ? 'Saved · not in history yet' : history === 'committed' ? 'In history' : 'Unknown'}
						</dd>
						<dt class="text-muted-foreground">ID</dt>
						<dd class="min-w-0 font-mono text-xs break-all">{id}</dd>
						<dt class="text-muted-foreground">Files</dt>
						<dd class="min-w-0 font-mono text-xs break-all">
							{editor.path}{#if audioPath}<br />{audioPath}{/if}{#each results as result (result.path)}<br />{result.path}{/each}
						</dd>
					</dl>
					</Collapsible.Content>
				</Collapsible.Root>
			</div>
		</Tabs.Content>
		<Tabs.Content value="source" class="min-h-0 flex-1">
			<Textarea
				class="h-full min-h-40 resize-none font-mono text-xs"
				value={editor.buffer}
				aria-label="Markdown source"
				spellcheck={false}
				oninput={(event) => editor.input(withFileNewlines(event.currentTarget.value, editor.buffer))}
			/>
		</Tabs.Content>
	</Tabs.Root>

	<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
		<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={() => void confirmDelete(library, editor.path)}>
			Delete recording
		</Button>
	</div>
</section>
