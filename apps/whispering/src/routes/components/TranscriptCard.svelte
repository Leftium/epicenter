<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { inspectRow } from '@epicenter/folder';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { whisperingDefinition } from '$lib/definition.js';
	import type { Library, TranscriptionEntry } from '$lib/library.svelte.js';
	import { transformationName } from '$lib/post-processing.js';
	import { copyText, formatTime, lf } from './file-actions.js';
	import LiveButton from './LiveButton.svelte';
	import LiveTextarea from './LiveTextarea.svelte';
	import RowSaveStatus from './RowSaveStatus.svelte';
	import TransformationOutput from './TransformationOutput.svelte';

	/**
	 * One saved transcript of the recording that is open, edited where it is
	 * read, beside the player. The text is the body of the transcript's own
	 * file, through the one row editor the library keeps for that file: the
	 * one Files shows for it, with the same saves. Nothing here selects the
	 * transcript's file, so the recording stays open.
	 */
	let { library, result }: { library: Library; result: TranscriptionEntry } = $props();

	// Open the file's editor once for this path. The editor outlives this
	// card: closing the details or changing page keeps what was typed.
	$effect(() => {
		const path = result.path;
		untrack(() => void library.openTranscript(path));
	});
	const slot = $derived(library.transcriptAt(result.path));
	/**
	 * The one row editor kept for the transcript's file. It can be replaced
	 * under this card (the file is opened again after it could not be read),
	 * so the binding reads it when it runs.
	 */
	const editing = $derived(slot?.kind === 'open' ? slot.editing : undefined);
	/** Only the fields view edits the text here; the whole file is edited in Files. */
	const editable = $derived(editing?.view === 'fields');
	/** The text now. Before the editor is open, the row as listed. */
	const text = $derived.by(() => {
		if (editing === undefined) return result.body;
		if (editing.row.status === 'valid') return editing.row.body;
		return inspectRow(whisperingDefinition.tables.transcriptions, editing.row.text).body;
	});
	const unsettled = $derived(editing !== undefined && editing.status.kind !== 'saved');
	// The live textarea has its own lifetime (LiveTextarea): one that is gone
	// delivers nothing, even after the fields view returns.

	const outputs = $derived(library.outputsFor(result.stem));
	const transforming = $derived(
		library.transformationRuns.some(
			(item) => item.fields.transcriptionId === result.stem && item.state.kind === 'running',
		),
	);
	/**
	 * Every transformation, with whether it can run now by the one decision
	 * the run itself makes. One that cannot is shown with why, and fixed on its
	 * own page or in Settings first.
	 */
	const choices = $derived(library.transformations.map((item) => ({ item, resolved: library.resolve(item) })));

	/** Apply a transformation to this transcript. The result is a new file; the transcript is not changed by it. */
	async function transform(path: string) {
		const problem = await library.transform(result.path, path);
		if (problem) toast.error('The transformation did not run', { description: problem });
	}
</script>

<article class="flex flex-col gap-2 rounded border p-3 text-sm" data-testid="transcription-result">
	{#if editable}
		<LiveTextarea
			class="min-h-32 resize-y font-sans"
			get={() => editing?.bodyText() ?? ''}
			set={(value) => editing?.setBody(value)}
			placeholder="This transcript has no text."
			aria-label="Transcript of {formatTime(result.fields.createdAt) || result.path}"
			data-testid="transcript-text"
		/>
	{:else if text !== undefined}
		<p class="max-h-64 overflow-y-auto rounded border p-2 whitespace-pre-wrap" data-testid="transcript-text-readonly">{text}</p>
	{/if}
	{#if editing?.view === 'source'}
		<p class="text-xs text-destructive" role="alert">
			This transcript’s file is being edited as text, so its text cannot be edited here. Open it from Files.
		</p>
	{:else if slot?.kind === 'unopened'}
		<p class="text-xs text-destructive" role="alert">
			This transcript’s file could not be opened: {slot.message}
			<LiveButton size="xs" variant="outline" class="ml-1" onclick={() => void library.retryOpen(result.path)}>Try again</LiveButton>
		</p>
	{/if}
	{#if editing && unsettled}
		<RowSaveStatus {library} {editing} />
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
					{#each choices as { item, resolved } (item.path)}
						<DropdownMenu.Item
							disabled={resolved.kind !== 'ready'}
							title={resolved.kind === 'blocked' ? resolved.reason : undefined}
							onSelect={() => void transform(item.path)}
						>
							<span class="flex min-w-0 flex-col">
								<span class="truncate">{transformationName(item)}</span>
								{#if resolved.kind === 'blocked'}
									<span class="text-xs text-muted-foreground">{resolved.fix === 'recipe' ? 'Needs repair' : 'Text connection not set up'}</span>
								{/if}
							</span>
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
		<TransformationOutput
			{library}
			output={{ source: 'transcript', entry: output }}
			naming="transformation"
			onOpenFile={(path) => void library.open(path)}
		/>
	{/each}
</article>
