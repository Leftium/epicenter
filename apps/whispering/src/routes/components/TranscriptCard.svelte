<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { patchRow } from '$lib/editor.svelte.js';
	import { withFileNewlines } from '$lib/files.js';
	import type { Library, TranscriptionEntry } from '$lib/library.svelte.js';
	import { copyText, formatTime } from './file-actions.js';
	import SaveStatus from './SaveStatus.svelte';
	import TransformationOutput from './TransformationOutput.svelte';

	/**
	 * One saved transcript of the recording that is open, edited where it is
	 * read, beside the player. The text is the body of the transcript's own
	 * file, through the one draft the library keeps for that file: the draft
	 * Files shows for it, with the same saves and the same conflict handling.
	 * Nothing here selects the transcript's file, so the recording stays open.
	 */
	let { library, result }: { library: Library; result: TranscriptionEntry } = $props();

	// Read the file into its draft once for this path. The draft outlives this
	// card: closing the details or changing page keeps what was typed.
	$effect(() => {
		const path = result.path;
		untrack(() => void library.openTranscript(path));
	});
	const file = $derived(library.fileAt(result.path));
	const editor = $derived(file?.kind === 'text' ? file.editor : undefined);
	/** How the draft reads now, saved or not. Before the draft is read, the row as listed. */
	const draft = $derived(editor ? library.folder.tables.transcriptions.inspect(editor.buffer) : result);
	const text = $derived(draft.body);
	/** A draft that does not parse has no body to edit here; its file is fixed in Files. */
	const editable = $derived(editor !== undefined && draft.parseError === undefined);
	const unsettled = $derived(
		editor !== undefined && (editor.dirty || editor.saveState.kind !== 'saved' || editor.refusal !== undefined),
	);

	const outputs = $derived(library.outputsFor(result.stem));
	const transforming = $derived(
		library.transformationRuns.some(
			(item) => item.fields.transcriptionId === result.stem && item.state.kind === 'running',
		),
	);
	/**
	 * Transformations that can run: a run needs the prompt and all three
	 * fields. One that lacks any is fixed on its own page first.
	 */
	const runnable = $derived(
		library.transformations.filter((item) => {
			const { title, model, endpoint } = item.fields;
			return item.body !== undefined && title !== undefined && model !== undefined && endpoint !== undefined;
		}),
	);

	/** Apply a transformation to this transcript. The result is a new file; the transcript is not changed by it. */
	async function transform(path: string) {
		const problem = await library.transform(result.path, path);
		if (problem) toast.error('The transformation did not run', { description: problem });
	}
</script>

<article class="flex flex-col gap-2 rounded border p-3 text-sm" data-testid="transcription-result">
	<Textarea
		class="min-h-32 resize-y font-sans"
		value={text ?? ''}
		placeholder={editable ? 'This transcript has no text.' : undefined}
		aria-label="Transcript of {formatTime(result.fields.createdAt) || result.path}"
		disabled={!editable}
		oninput={(event) =>
			editor && patchRow(editor, { body: withFileNewlines(event.currentTarget.value, text ?? '') })}
		data-testid="transcript-text"
	/>
	{#if file?.kind === 'failed'}
		<p class="text-xs text-destructive" role="alert">This transcript’s file could not be opened for editing: {file.message}</p>
	{:else if editor && draft.parseError}
		<p class="text-xs text-destructive" role="alert">
			This transcript’s file does not read as a transcript, so its text cannot be edited here. Fix it from Files.
		</p>
	{/if}
	{#if editor && unsettled}
		<SaveStatus {editor} autosavePaused={library.autosave.paused} onDiscardRemoved={() => library.discardRemoved(editor.path)} />
	{/if}
	<footer class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
		<span>{formatTime(result.fields.createdAt) || 'Unknown time'} · {result.fields.model ?? 'unknown model'}</span>
		<span class="ml-auto flex items-center gap-1">
			<Button size="xs" variant="outline" disabled={!text?.trim()} onclick={() => void copyText(text ?? '', 'the transcript')} data-testid="copy-transcript">
				Copy
			</Button>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} size="xs" variant="outline" disabled={!text?.trim()} data-testid="transform">
							{#if transforming}<Spinner class="size-3" />{:else}<WandSparklesIcon />{/if}
							Transform
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="min-w-52">
					<DropdownMenu.Label>Make a new text from this transcript</DropdownMenu.Label>
					{#each runnable as item (item.path)}
						<DropdownMenu.Item onSelect={() => void transform(item.path)}>
							{item.fields.title || (item.stem === '' ? item.path : item.stem)}
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
		</span>
	</footer>
	{#each outputs as output (output.path)}
		<TransformationOutput {library} {output} naming="transformation" onOpenFile={(path) => void library.open(path)} />
	{/each}
</article>
