<script lang="ts">
	import { readSource } from '@epicenter/app/files';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Tabs from '@epicenter/ui/tabs';
	import { Textarea } from '@epicenter/ui/textarea';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { patchRow, type RecordingEditor, type RecordingEntry, stemOf } from '$lib/editor.svelte.js';
	import { withFileNewlines } from '$lib/files.js';
	import type { Library, TranscriptionEntry } from '$lib/library.svelte.js';
	import { committedState } from '$lib/status.js';
	import AudioPlayer from './AudioPlayer.svelte';
	import { confirmDelete, copyText } from './file-actions.js';
	import SaveStatus from './SaveStatus.svelte';
	import TransformationOutput from './TransformationOutput.svelte';

	let {
		library,
		editor,
		entry,
		onBack,
	}: {
		library: Library;
		editor: RecordingEditor;
		/** The listed row, or undefined when the file left the folder. */
		entry: RecordingEntry | undefined;
		/** Shown on narrow windows, where the list and the details take turns. */
		onBack?: () => void;
	} = $props();

	/** The buffer's interpretation. Details and Source are two views of this one draft. */
	const parsed = $derived(readSource(editor.buffer));
	const title = $derived(typeof parsed.values?.title === 'string' ? parsed.values.title : '');
	const fieldsEditable = $derived(parsed.values !== undefined && parsed.body !== undefined);
	const id = $derived(stemOf(editor.path));
	const results = $derived(library.resultsFor(id));
	const run = $derived(library.transcriptionRun(id));
	const history = $derived(
		entry ? committedState(library.git, [entry.path, ...(entry.attachment ? [entry.attachment] : [])]) : undefined,
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

	/** Transformations that can run; one that needs repair is fixed on its own page first. */
	const runnable = $derived(library.transformations.filter((item) => item.issues === undefined));

	/** Apply a transformation to one transcript. The result is a new file; the transcript is not changed. */
	async function transform(result: TranscriptionEntry, path: string) {
		const problem = await library.transform(result.path, path);
		if (problem) toast.error('The transformation did not run', { description: problem });
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
		{#if history === 'uncommitted'}
			<Badge variant="outline" data-testid="recording-history">Saved · not in history yet</Badge>
		{:else if history === 'committed'}
			<Badge variant="secondary" data-testid="recording-history">In history</Badge>
		{/if}
	</div>

	<SaveStatus {editor} autosavePaused={library.autosave.paused} onDiscardRemoved={() => library.discardRemoved(editor.path)} />

	{#if entry?.issues || parsed.issues.length > 0}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs" data-testid="needs-repair">
			<p class="mb-1 flex items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				Edit the source to fix it; the file stays saved as written.
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each entry?.issues ?? [] as issue, index (index)}
					<li>{issue.kind === 'field' ? `${issue.field}: ` : ''}{issue.message}</li>
				{/each}
				{#if !entry?.issues}
					{#each parsed.issues as issue, index (index)}
						<li>Unsaved source: {issue.message}</li>
					{/each}
				{/if}
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
				{#if entry?.attachment}
					<AudioPlayer
						source={{ kind: 'file', files: library.folder.files, path: entry.attachment, generation: library.generation }}
						label="Audio of {title || id}"
					/>
				{:else}
					<p class="text-sm text-muted-foreground">This recording has no audio file beside its row.</p>
				{/if}

				<dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
					<dt class="text-muted-foreground">Recorded</dt>
					<dd>{when(parsed.values?.recordedAt)}</dd>
					<dt class="text-muted-foreground">Length</dt>
					<dd>{seconds(parsed.values?.durationMs)}</dd>
					<dt class="text-muted-foreground">Captured from</dt>
					<dd>
						{#if parsed.values?.capture === 'fixture'}
							<Badge variant="outline">Fixture audio, not a microphone take</Badge>
						{:else if parsed.values?.capture === 'microphone'}
							Microphone
						{:else}
							Unknown
						{/if}
					</dd>
					<dt class="text-muted-foreground">Files</dt>
					<dd class="min-w-0 font-mono text-xs break-all">
						{editor.path}{#if entry?.attachment}<br />{entry.attachment}{/if}
					</dd>
				</dl>

				<div class="flex flex-col gap-2">
					<div class="flex items-center gap-2">
						<h3 class="text-sm font-medium">Transcription</h3>
						<Button
							class="ml-auto"
							size="sm"
							disabled={entry === undefined || entry.attachment === undefined || run?.kind === 'running'}
							onclick={() => entry && void library.transcribe(entry)}
							data-testid="transcribe"
						>
							{#if run?.kind === 'running'}<Spinner class="size-3.5" />{/if}
							{results.length > 0 ? 'Transcribe again' : 'Transcribe'}
						</Button>
					</div>
					<p class="text-xs text-muted-foreground">
						{library.settings.transcriptionModel} at {library.settings.transcriptionBaseUrl}
					</p>
					{#if run?.kind === 'failed'}
						<p class="text-sm text-destructive" role="alert" data-testid="transcription-error">
							{run.message}
							<Button size="xs" variant="outline" class="ml-2" onclick={() => library.dismissRun(id)}>Dismiss</Button>
						</p>
					{:else if run?.kind === 'unsaved'}
						<div class="rounded border border-destructive/40 p-2 text-sm" role="alert">
							<p class="text-destructive">The transcript arrived but its file was not saved: {run.message}</p>
							<p class="my-2 whitespace-pre-wrap">{run.text}</p>
							<Button size="xs" onclick={() => void library.retrySaveResult(id)}>Save it again</Button>
						</div>
					{/if}
					{#each results as result (result.path)}
						{@const outputs = result.stem ? library.outputsFor(result.stem) : []}
						{@const transforming = library.transformationRuns.some(
							(item) => item.fields.transcriptionId === result.stem && item.state.kind === 'running',
						)}
						<article class="flex flex-col gap-2 rounded border p-3 text-sm" data-testid="transcription-result">
							<p class="whitespace-pre-wrap" data-testid="transcript-text">{result.body?.trim() || '(empty transcript)'}</p>
							<footer class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
								<span>{when(result.fields.createdAt)} · {result.fields.model ?? 'unknown model'}</span>
								<Button size="xs" variant="ghost" onclick={() => void library.open(result.path)}>
									<code class="font-mono">{result.path}</code>
								</Button>
								<span class="ml-auto flex items-center gap-1">
									<DropdownMenu.Root>
										<DropdownMenu.Trigger>
											{#snippet child({ props })}
												<Button {...props} size="xs" variant="outline" disabled={!result.body?.trim()} data-testid="transform">
													{#if transforming}<Spinner class="size-3" />{:else}<WandSparklesIcon />{/if}
													Transform
												</Button>
											{/snippet}
										</DropdownMenu.Trigger>
										<DropdownMenu.Content align="end" class="min-w-52">
											<DropdownMenu.Label>Make a new text from this transcript</DropdownMenu.Label>
											{#each runnable as item (item.path)}
												<DropdownMenu.Item onSelect={() => void transform(result, item.path)}>
													{item.fields.title || item.stem}
												</DropdownMenu.Item>
											{:else}
												<DropdownMenu.Item disabled>No transformations yet</DropdownMenu.Item>
											{/each}
											<DropdownMenu.Separator />
											<DropdownMenu.Item onSelect={() => void goto(resolve('/transformations'))}>
												Manage transformations…
											</DropdownMenu.Item>
										</DropdownMenu.Content>
									</DropdownMenu.Root>
									<Button size="xs" variant="ghost" onclick={() => void copyText(result.body ?? '', 'the transcript')}>Copy</Button>
								</span>
							</footer>
							{#each outputs as output (output.path)}
								<TransformationOutput {library} {output} naming="transformation" onOpenFile={(path) => void library.open(path)} />
							{/each}
						</article>
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
						value={parsed.body ?? ''}
						placeholder="Notes in Markdown, saved in the recording’s file"
						aria-label="Notes"
						disabled={parsed.body === undefined}
						oninput={(event) =>
							patchRow(editor, { body: withFileNewlines(event.currentTarget.value, parsed.body ?? '') })}
					/>
				</div>
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
		<span>ID <code class="font-mono">{id}</code></span>
		<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={() => void confirmDelete(library, editor.path)}>
			Delete recording
		</Button>
	</div>
</section>
