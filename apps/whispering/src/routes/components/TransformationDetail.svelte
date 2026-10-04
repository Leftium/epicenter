<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import * as Select from '@epicenter/ui/select';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Tabs from '@epicenter/ui/tabs';
	import { Textarea } from '@epicenter/ui/textarea';
	import { Loading } from '@epicenter/ui/loading';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import PlayIcon from '@lucide/svelte/icons/play';
	import { inspectRow, rowStemOf } from '@epicenter/folder';
	import {
		TRANSFORMATIONS,
		type TransformationFields,
		whisperingDefinition,
	} from '$lib/definition.js';
	import { withFileNewlines } from '$lib/files.js';
	import type { Library, RowSlot, TextRun, TransformationEntry } from '$lib/library.svelte.js';
	import { recipeEndpoint } from '$lib/recipe.js';
	import { committedState } from '$lib/status.js';
	import { confirmDelete, copyText, formatTime, recordingTitle } from './file-actions.js';
	import RowSaveStatus from './RowSaveStatus.svelte';
	import SaveStatus from './SaveStatus.svelte';
	import TransformationOutput from './TransformationOutput.svelte';

	let {
		library,
		path,
		slot,
		entry,
		applyTo = $bindable(),
		applySource = $bindable(),
		pastedText = $bindable(),
		onBack,
		onOpenFile,
	}: {
		library: Library;
		path: string;
		/** The one draft kept for the transformation's file. */
		slot: RowSlot<TransformationFields>;
		/** The listed row, or undefined when the file left the folder. */
		entry: TransformationEntry | undefined;
		/** The transcription this is tried on, by row path. Kept by the session across pages. */
		applyTo: string | undefined;
		/** Whether this is tried on a saved transcript or on pasted text. Kept by the session. */
		applySource: 'transcript' | 'pasted';
		/** The pasted text. Kept by the session, so it stays across pages and transformations. */
		pastedText: string;
		/** Shown on narrow windows, where the list and the editor take turns. */
		onBack?: () => void;
		onOpenFile: (path: string) => void;
	} = $props();

	/** The folder's row editor, when the file opens as fields. */
	const form = $derived(slot.kind === 'form' ? slot.draft : undefined);
	/** The file's text, when it is edited as text: to repair it, or by choice. */
	const raw = $derived(slot.kind === 'raw' ? slot : undefined);
	/**
	 * How the draft reads, saved or not: the form's document, or the text on
	 * screen by the transformations table's own interpreter. Every message
	 * below describes it, never the file as last saved.
	 */
	const draft = $derived(
		form ? form.state.reading : inspectRow(whisperingDefinition.tables.transformations, raw?.editor.buffer ?? ''),
	);
	/** The values being typed, which may not conform yet. */
	const typed = $derived(form?.state.document);
	const text = (key: 'title' | 'model' | 'endpoint') => {
		const value = typed ? typed.fields[key] : draft.fields[key];
		return typeof value === 'string' ? value : '';
	};
	// Fields and instructions are edited in the form; text that is not a row is fixed in Source.
	const fieldsEditable = $derived(form !== undefined);
	const id = $derived(rowStemOf(TRANSFORMATIONS, path) ?? path);
	/** The one decision about this recipe, for the draft on screen; Run saves the draft and decides again. */
	const resolved = $derived(library.resolve(draft));
	const connection = $derived(library.connections?.text);
	const constraint = $derived(recipeEndpoint(draft.fields));
	/** Saved results on transcripts and on pasted text, newest first. */
	const outputs = $derived(
		[
			...library.outputsOf(id).map((item) => ({ source: 'transcript' as const, entry: item })),
			...library.textOutputsOf(id).map((item) => ({ source: 'text' as const, entry: item })),
		].sort((a, b) => (b.entry.fields.createdAt ?? '').localeCompare(a.entry.fields.createdAt ?? '')),
	);
	const history = $derived(entry ? committedState(library.git, [entry.path]) : undefined);
	let tab = $state('details');

	/**
	 * Saved transcripts with text, newest first, named by their recording. Any
	 * recording offers its transcripts, whatever its file is named and whatever
	 * else in its file needs fixing.
	 */
	const transcripts = $derived(
		library.entries.flatMap((recording) =>
			library
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
	/** This recipe's run on pasted text that is not a saved result: running, failed, or waiting for Save. */
	const textRun = $derived<TextRun | undefined>(library.textRuns.find((run) => run.fields.transformationId === id));
	/** Why Run is unavailable, in the order a person would fix it, or undefined when it can run. */
	const blocked = $derived.by(() => {
		if (entry === undefined) return 'This transformation is not in the folder.';
		// Running saves this draft first, so what has to be sound is the draft.
		if (resolved.kind === 'blocked') return resolved.reason;
		if (applySource === 'pasted') {
			if (textRun?.state.kind === 'running') return 'Running on pasted text…';
			if (textRun?.state.kind === 'unsaved') return 'Save or discard the result below before running this again.';
			if (pastedText.trim() === '') return 'Paste some text to run this on.';
			return undefined;
		}
		if (transcripts.length === 0) return 'Transcribe a recording first, or paste text to run this on.';
		if (chosen === undefined) return 'Choose a transcript to run this on.';
		return undefined;
	});

	async function run() {
		const problem =
			applySource === 'pasted'
				? await library.transformText(path, pastedText)
				: chosen && (await library.transform(chosen.result.path, path));
		if (problem) toast.error('The transformation did not run', { description: problem });
	}

	async function save(run: TextRun) {
		await library.saveTextRun(run.id);
		const after = library.textRuns.find((item) => item.id === run.id);
		if (after?.state.kind === 'unsaved' && after.state.message)
			toast.error('The result was not saved', { description: after.state.message });
	}

	function discard(run: TextRun) {
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

	async function editText() {
		const problem = await library.editSource(path);
		if (problem) toast.error('The text was not opened for editing', { description: problem });
	}

	async function editFields() {
		const problem = await library.useForm(path);
		if (problem) toast.error('The fields were not opened', { description: problem });
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
			oninput={(event) => form?.change({ fields: { title: event.currentTarget.value } })}
			data-testid="transformation-title"
		/>
		{#if history === 'uncommitted'}
			<Badge variant="outline">Saved · not in history yet</Badge>
		{:else if history === 'committed'}
			<Badge variant="secondary">In history</Badge>
		{/if}
	</div>

	{#if form}
		<RowSaveStatus {library} draft={form} />
	{:else if raw}
		<SaveStatus editor={raw.editor} autosavePaused={library.autosave.paused} onDiscardRemoved={() => void library.discardDraft(path)} />
	{/if}

	<!-- The form shows its own issues in its save line; these are for text being repaired. -->
	{#if raw && draft.parseError}
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
	{:else if raw && draft.issues.length > 0}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs" data-testid="needs-repair">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				Some fields need fixing in Source.
				{#if tab !== 'source'}
					<Button size="xs" variant="outline" onclick={() => (tab = 'source')}>Edit Source</Button>
				{/if}
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each draft.issues as issue, index (index)}
					<li>{issue.message}</li>
				{/each}
			</ul>
		</div>
	{:else if raw?.reason}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs" data-testid="needs-repair">
			<p class="flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Edited as text</Badge>
				{raw.reason} Repair it in Source, or choose Edit the fields to check it again.
			</p>
		</div>
	{/if}

	{#if slot.kind === 'opening'}
		<Loading class="flex-1" label="Opening the transformation…" />
	{:else}
	<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
		<Tabs.List>
			<Tabs.Trigger value="details">Details</Tabs.Trigger>
			<Tabs.Trigger value="source">Source</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="details" class="min-h-0 flex-1 overflow-y-auto">
			<div class="flex flex-col gap-5 py-1">
				<Field.Group>
					<Field.Field>
						<Field.Label for="transformation-prompt">Instructions</Field.Label>
						<Textarea
							id="transformation-prompt"
							class="min-h-36 resize-y font-sans"
							value={typed?.body ?? draft.body ?? ''}
							placeholder="Say what to do with the text, such as: Fix punctuation and remove filler words. Answer with the text only."
							disabled={!fieldsEditable}
							oninput={(event) =>
								typed && form?.change({ body: withFileNewlines(event.currentTarget.value, typed.body) })}
							data-testid="transformation-prompt"
						/>
						<Field.Description>
							Sent as the instruction. The transcript or pasted text is sent after it, unchanged. This is the file’s Markdown body.
						</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="transformation-model">Model (optional)</Field.Label>
						<Input
							id="transformation-model"
							value={text('model')}
							placeholder={connection?.model ? `The text connection’s model: ${connection.model}` : 'The text connection’s model'}
							autocomplete="off"
							spellcheck={false}
							disabled={!fieldsEditable}
							oninput={(event) =>
								form?.change({
									fields: { model: event.currentTarget.value.trim() === '' ? null : event.currentTarget.value },
								})}
							data-testid="transformation-model"
						/>
						<Field.Description>
							Leave empty to use the text connection’s model. Typed exactly as the endpoint names it; Whispering keeps no list of models.
						</Field.Description>
					</Field.Field>
				</Field.Group>

				<div class="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="transform-note">
					{#if constraint}
						<p class="text-foreground" data-testid="transformation-endpoint-constraint">
							An earlier version saved the endpoint {constraint} in this transformation. It runs only while the text connection is exactly
							that endpoint; the request always goes to the connection.
						</p>
						<Button
							size="xs"
							variant="outline"
							class="self-start"
							disabled={!fieldsEditable}
							onclick={() => form?.change({ fields: { endpoint: null } })}
							data-testid="remove-endpoint-constraint"
						>
							Remove the endpoint and use the text connection
						</Button>
					{/if}
					{#if connection}
						<p>Sends to the text connection: {connection.baseUrl}{connection.keyPresent ? ', with its key' : ', with no key'}.</p>
					{:else if library.connectionsProblem}
						<p class="text-destructive">The text connection could not be read: {library.connectionsProblem}</p>
					{:else}
						<p>No text connection is set up. Set one up in Settings to run this.</p>
					{/if}
					<p>{library.workspace.transformNote}</p>
				</div>

				<div class="flex flex-col gap-2">
					<h3 class="text-sm font-medium">Run it</h3>
					<Tabs.Root
						value={applySource}
						onValueChange={(next) => (applySource = next === 'pasted' ? 'pasted' : 'transcript')}
						class="flex flex-col gap-2"
					>
						<Tabs.List class="self-start">
							<Tabs.Trigger value="transcript" data-testid="apply-transcript">A transcript</Tabs.Trigger>
							<Tabs.Trigger value="pasted" data-testid="apply-pasted">Pasted text</Tabs.Trigger>
						</Tabs.List>
						<Tabs.Content value="transcript" class="flex flex-col gap-2">
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
								<p class="text-xs text-muted-foreground" data-testid="run-blocked">{blocked}</p>
							{:else if chosen}
								<p class="max-h-24 overflow-y-auto rounded border p-2 text-xs whitespace-pre-wrap text-muted-foreground">{chosen.result.body?.trim()}</p>
								<p class="text-xs text-muted-foreground">
									Running saves these edits first, sends the instructions and this transcript, and writes the answer to a new file in
									<code class="font-mono">transformation_runs/</code>.
								</p>
							{/if}
						</Tabs.Content>
						<Tabs.Content value="pasted" class="flex flex-col gap-2">
							<Textarea
								class="min-h-28 resize-y font-sans"
								bind:value={pastedText}
								placeholder="Paste text to try this on. It stays here while you move between pages and transformations, and is not saved anywhere."
								aria-label="Text to transform"
								data-testid="pasted-text"
							/>
							<div class="flex flex-wrap items-center gap-2">
								<Button disabled={blocked !== undefined} onclick={() => void run()} data-testid="run-pasted">
									{#if textRun?.state.kind === 'running'}<Spinner class="size-3.5" />{:else}<PlayIcon />{/if}
									Run on pasted text
								</Button>
								{#if blocked}
									<span class="text-xs text-muted-foreground" data-testid="run-blocked">{blocked}</span>
								{:else}
									<span class="text-xs text-muted-foreground">
										Running saves these edits first and sends the instructions and this text. The answer stays here until you save it.
									</span>
								{/if}
							</div>
						</Tabs.Content>
					</Tabs.Root>

					{#if textRun}
						<div class="flex flex-col gap-2 rounded border p-3 text-sm" data-testid="text-run" data-run-state={textRun.state.kind}>
							{#if textRun.state.kind === 'running'}
								<p class="flex items-center gap-2 font-medium"><Spinner class="size-3.5" /> Running on pasted text…</p>
							{:else if textRun.state.kind === 'failed'}
								<p class="font-medium">No result was received.</p>
								<p class="text-xs text-muted-foreground" role="alert" data-testid="text-run-error">{textRun.state.message}</p>
								<div class="flex items-center gap-2">
									<Button size="sm" disabled={library.isRetrying(textRun.id)} onclick={() => void library.retryTransformation(textRun.id)} data-testid="retry-text-run">
										Try again
									</Button>
									<Button size="sm" variant="ghost" onclick={() => discard(textRun)}>Dismiss</Button>
								</div>
							{:else}
								{@const result = textRun.state.text}
								<p class="font-medium">The result arrived. It is not saved until you save it.</p>
								{#if textRun.state.message}
									<p class="text-xs text-destructive" role="alert" data-testid="text-run-save-error">{textRun.state.message}</p>
								{/if}
								<div class="grid gap-2 sm:grid-cols-2">
									<div class="flex min-w-0 flex-col gap-1">
										<span class="text-xs text-muted-foreground">Pasted text, as sent</span>
										<p class="max-h-48 overflow-y-auto rounded border bg-background p-2 text-xs whitespace-pre-wrap">{textRun.fields.input}</p>
									</div>
									<div class="flex min-w-0 flex-col gap-1">
										<span class="text-xs text-muted-foreground">Result · {textRun.fields.model} at {textRun.fields.endpoint}</span>
										<p class="max-h-48 overflow-y-auto rounded border bg-background p-2 whitespace-pre-wrap" data-testid="text-run-result">{result}</p>
									</div>
								</div>
								<p class="text-xs text-muted-foreground">
									Saving writes <code class="font-mono">text_runs/{textRun.id}.md</code> with what was sent. The endpoint is not called again.
								</p>
								<div class="flex items-center gap-2">
									<Button size="sm" disabled={library.isRetrying(textRun.id)} onclick={() => void save(textRun)} data-testid="save-text-run">
										{#if library.isRetrying(textRun.id)}<Spinner class="size-3.5" />{/if}
										Save
									</Button>
									<Button size="sm" variant="outline" onclick={() => void copyText(result, 'the result')}>Copy</Button>
									<Button size="sm" variant="ghost-destructive" onclick={() => discard(textRun)} data-testid="discard-text-run">Discard</Button>
								</div>
							{/if}
						</div>
					{/if}
				</div>

				<div class="flex flex-col gap-2">
					<h3 class="text-sm font-medium">Results</h3>
					{#if library.textResultsError}
						<p class="text-xs text-destructive" role="alert" data-testid="text-results-error">
							Results on pasted text could not be listed, so this is the last list that was: {library.textResultsError}
						</p>
					{/if}
					{#each outputs as output (output.entry.path)}
						<TransformationOutput {library} {output} naming="source" {onOpenFile} />
					{:else}
						<p class="text-sm text-muted-foreground">No results yet.</p>
					{/each}
					{#if library.unreadableTextResults.length > 0}
						<p class="text-xs text-warning" role="status">
							Files in <code class="font-mono">text_runs/</code> that could not be read as text:
							{library.unreadableTextResults.map((item) => item.path).join(', ')}
						</p>
					{/if}
				</div>
			</div>
		</Tabs.Content>
		<Tabs.Content value="source" class="flex min-h-0 flex-1 flex-col gap-2">
			{#if form}
				<p class="text-xs text-muted-foreground">
					What a save writes: the fields above in a fixed form, then the instructions. Fields the app does not know are kept.
					<Button size="xs" variant="outline" class="ml-1" onclick={() => void editText()} data-testid="edit-text">Edit the text</Button>
				</p>
				<Textarea
					class="h-full min-h-40 flex-1 resize-none font-mono text-xs"
					value={form.state.text}
					aria-label="Markdown source"
					readonly
					spellcheck={false}
				/>
			{:else if raw}
				{@const editor = raw.editor}
				<p class="text-xs text-muted-foreground">
					The file’s exact text. It saves as typed, readable or not.
					<Button size="xs" variant="outline" class="ml-1" onclick={() => void editFields()} data-testid="edit-fields">Edit the fields</Button>
				</p>
				<Textarea
					class="h-full min-h-40 flex-1 resize-none font-mono text-xs"
					value={editor.buffer}
					aria-label="Markdown source"
					spellcheck={false}
					oninput={(event) => editor.input(withFileNewlines(event.currentTarget.value, editor.buffer))}
				/>
			{/if}
		</Tabs.Content>
	</Tabs.Root>
	{/if}

	<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
		<span><code class="font-mono">{path}</code></span>
		<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={() => void confirmDelete(library, path)} data-testid="delete-transformation">
			Delete transformation
		</Button>
	</div>
</section>
