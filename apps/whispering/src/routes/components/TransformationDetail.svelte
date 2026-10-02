<script lang="ts">
	import { readSource } from '@epicenter/folder';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import * as Select from '@epicenter/ui/select';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Tabs from '@epicenter/ui/tabs';
	import { Textarea } from '@epicenter/ui/textarea';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import PlayIcon from '@lucide/svelte/icons/play';
	import { patchRow, type TransformationEditor } from '$lib/editor.svelte.js';
	import { withFileNewlines } from '$lib/files.js';
	import type { Library, TransformationEntry } from '$lib/library.svelte.js';
	import { committedState } from '$lib/status.js';
	import { confirmDelete, formatTime, recordingTitle } from './file-actions.js';
	import SaveStatus from './SaveStatus.svelte';
	import TransformationOutput from './TransformationOutput.svelte';

	let {
		library,
		editor,
		entry,
		applyTo = $bindable(),
		onBack,
		onOpenFile,
	}: {
		library: Library;
		editor: TransformationEditor;
		/** The listed row, or undefined when the file left the folder. */
		entry: TransformationEntry | undefined;
		/** The transcription this is tried on, by row path. Kept by the session across pages. */
		applyTo: string | undefined;
		/** Shown on narrow windows, where the list and the editor take turns. */
		onBack?: () => void;
		onOpenFile: (path: string) => void;
	} = $props();

	/** The buffer's interpretation. Details and Source are two views of this one draft. */
	const parsed = $derived(readSource(editor.buffer));
	const text = (key: string) => {
		const value = parsed.values?.[key];
		return typeof value === 'string' ? value : '';
	};
	const fieldsEditable = $derived(parsed.values !== undefined && parsed.body !== undefined);
	const id = $derived(editor.baseline.stem);
	const outputs = $derived(library.outputsOf(id));
	const history = $derived(entry ? committedState(library.git, [entry.path]) : undefined);
	let tab = $state('details');

	/**
	 * Saved transcripts with text, newest first, named by their recording. A
	 * recording whose filename needs repair offers none: its ID is not one to
	 * run a transformation against. Other problems in its file do not hide it.
	 */
	const transcripts = $derived(
		library.entries.flatMap((recording) =>
			recording.issues?.some((issue) => issue.kind === 'filename')
				? []
				: library
						.resultsFor(recording.stem)
						.filter((result) => (result.body ?? '').trim() !== '')
						.map((result) => ({
							result,
							label: `${recordingTitle(recording)} · ${formatTime(result.fields.createdAt, 'short')}`,
						})),
		),
	);
	const chosen = $derived(transcripts.find((item) => item.result.path === applyTo));
	const running = $derived(
		library.transformationRuns.some((run) => run.fields.transformationId === id && run.state.kind === 'running'),
	);
	/** Why Run is unavailable, in the order a person would fix it, or undefined when it can run. */
	const blocked = $derived.by(() => {
		if (entry === undefined) return 'This transformation is not in the folder.';
		if (entry.issues !== undefined || parsed.issues.length > 0) return 'Repair this transformation before running it.';
		if (text('endpoint').trim() === '') return 'Add an endpoint to run this.';
		if (text('model').trim() === '') return 'Add a model to run this.';
		if ((parsed.body ?? '').trim() === '') return 'Write a prompt to run this.';
		if (transcripts.length === 0) return 'Transcribe a recording first; a transformation runs on a saved transcript.';
		if (chosen === undefined) return 'Choose a transcript to run this on.';
		return undefined;
	});

	async function run() {
		if (chosen === undefined) return;
		const problem = await library.transform(chosen.result.path, editor.path);
		if (problem) toast.error('The transformation did not run', { description: problem });
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Transformation" data-testid="transformation-detail">
	<div class="flex items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to transformations" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		<Input
			class="flex-1 text-base font-medium"
			value={text('title')}
			placeholder="Title"
			aria-label="Transformation title"
			disabled={!fieldsEditable}
			oninput={(event) => patchRow(editor, { fields: { title: event.currentTarget.value } })}
			data-testid="transformation-title"
		/>
		{#if history === 'uncommitted'}
			<Badge variant="outline">Saved · not in history yet</Badge>
		{:else if history === 'committed'}
			<Badge variant="secondary">In history</Badge>
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
			<div class="flex flex-col gap-5 py-1">
				<Field.Group>
					<Field.Field>
						<Field.Label for="transformation-prompt">Prompt</Field.Label>
						<Textarea
							id="transformation-prompt"
							class="min-h-36 resize-y font-sans"
							value={parsed.body ?? ''}
							placeholder="Say what to do with the transcript, such as: Fix punctuation and remove filler words. Answer with the text only."
							disabled={parsed.body === undefined}
							oninput={(event) => patchRow(editor, { body: withFileNewlines(event.currentTarget.value, parsed.body ?? '') })}
							data-testid="transformation-prompt"
						/>
						<Field.Description>
							Sent as the instruction. The transcript is sent after it, unchanged. This is the file’s Markdown body.
						</Field.Description>
					</Field.Field>
					<div class="grid gap-4 sm:grid-cols-2">
						<Field.Field>
							<Field.Label for="transformation-endpoint">Endpoint</Field.Label>
							<Input
								id="transformation-endpoint"
								value={text('endpoint')}
								placeholder="https://api.openai.com/v1"
								autocomplete="off"
								spellcheck={false}
								disabled={!fieldsEditable}
								oninput={(event) => patchRow(editor, { fields: { endpoint: event.currentTarget.value } })}
								data-testid="transformation-endpoint"
							/>
							<Field.Description>An OpenAI-compatible base URL. The request goes to <code class="font-mono">/chat/completions</code> under it.</Field.Description>
						</Field.Field>
						<Field.Field>
							<Field.Label for="transformation-model">Model</Field.Label>
							<Input
								id="transformation-model"
								value={text('model')}
								placeholder="The chat model this endpoint serves"
								autocomplete="off"
								spellcheck={false}
								disabled={!fieldsEditable}
								oninput={(event) => patchRow(editor, { fields: { model: event.currentTarget.value } })}
								data-testid="transformation-model"
							/>
							<Field.Description>Typed exactly as the endpoint names it. Whispering keeps no list of models.</Field.Description>
						</Field.Field>
					</div>
				</Field.Group>
				<p class="text-xs text-muted-foreground" data-testid="transform-note">
					{library.workspace.transformNote}
					{library.credentialPresent ? '' : 'No API key is set; a local endpoint may not need one.'}
				</p>

				<div class="flex flex-col gap-2">
					<h3 class="text-sm font-medium">Run it on a transcript</h3>
					<div class="flex flex-wrap items-center gap-2">
						<Select.Root type="single" bind:value={() => applyTo ?? '', (value) => (applyTo = value || undefined)}>
							<Select.Trigger class="min-w-0 flex-1" aria-label="Transcript to transform" disabled={transcripts.length === 0} data-testid="transformation-input">
								<span class="truncate">{chosen?.label ?? (transcripts.length === 0 ? 'No saved transcripts yet' : 'Choose a transcript')}</span>
							</Select.Trigger>
							<Select.Content>
								{#each transcripts as item (item.result.path)}
									<Select.Item value={item.result.path} label={item.label} />
								{/each}
							</Select.Content>
						</Select.Root>
						<Button disabled={blocked !== undefined || running} onclick={() => void run()} data-testid="run-transformation">
							{#if running}<Spinner class="size-3.5" />{:else}<PlayIcon />{/if}
							Run
						</Button>
					</div>
					{#if blocked}
						<p class="text-xs text-muted-foreground">{blocked}</p>
					{:else if chosen}
						<p class="max-h-24 overflow-y-auto rounded border p-2 text-xs whitespace-pre-wrap text-muted-foreground">{chosen.result.body?.trim()}</p>
						<p class="text-xs text-muted-foreground">
							Running saves these edits first, sends the prompt and this transcript, and writes the answer to a new file in
							<code class="font-mono">transformation_runs/</code>.
						</p>
					{/if}
				</div>

				<div class="flex flex-col gap-2">
					<h3 class="text-sm font-medium">Results</h3>
					{#each outputs as output (output.path)}
						<TransformationOutput {library} {output} naming="recording" {onOpenFile} />
					{:else}
						<p class="text-sm text-muted-foreground">No results yet.</p>
					{/each}
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
		<span><code class="font-mono">{editor.path}</code></span>
		<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={() => void confirmDelete(library, editor.path)} data-testid="delete-transformation">
			Delete transformation
		</Button>
	</div>
</section>
