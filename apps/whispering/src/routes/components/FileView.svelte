<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { Textarea } from '@epicenter/ui/textarea';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileIcon from '@lucide/svelte/icons/file';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { audioMimeTypeOf } from '$lib/audio-format.js';
	import type { TranscriptionFields } from '$lib/definition.js';
	import { basename, dirname, withFileNewlines } from '@epicenter/folder/file-browser';
	import { toast } from '@epicenter/ui/sonner';
	import type { Library, OpenFile, RowSlot } from '$lib/library.svelte.js';
	import AudioPlayer from './AudioPlayer.svelte';
	import { confirmDelete, copyPath, lf } from './file-actions.js';
	import FileNameBar from './FileNameBar.svelte';
	import LiveButton from './LiveButton.svelte';
	import LiveTextarea from './LiveTextarea.svelte';
	import RowSaveStatus from './RowSaveStatus.svelte';
	import SaveStatus from './SaveStatus.svelte';

	let {
		library,
		path,
		file,
		onBack,
	}: {
		library: Library;
		path: string;
		/**
		 * The file, or the one row editor kept for a transcript's file: the
		 * same editor the transcript is edited through beside its recording.
		 */
		file: OpenFile | { readonly kind: 'row'; readonly slot: RowSlot<TranscriptionFields> };
		/** Shown on narrow windows, where the list and the editor take turns. */
		onBack?: () => void;
	} = $props();

	/** An ordinary file's text draft. */
	const text = $derived(file.kind === 'text' ? { editor: file.editor } : undefined);
	/**
	 * A transcript's one row editor: its body as fields, or its whole text.
	 * This view is reused for every selected file, so each binding reads
	 * `editing` when it runs, never the editor it first saw. Each live control
	 * has its own lifetime (LiveTextarea, LiveButton): one that is gone
	 * delivers nothing, even after its mode returns.
	 */
	const editing = $derived(file.kind === 'row' && file.slot.kind === 'open' ? file.slot.editing : undefined);
	function showSource(next: boolean) {
		const problem = next ? library.editSource(path) : library.useForm(path);
		if (problem)
			toast.error(next ? 'The text was not opened for editing' : 'The text was not opened alone', {
				description: problem,
			});
	}

	const name = $derived(basename(path));
	const directory = $derived(dirname(path));
	/** The recording whose row names this file as its audio, if one does. */
	const owner = $derived(library.recordingNaming(path));

	/** A file shown as details: its extension names the type, then its size. */
	function details(size: number) {
		const dot = name.lastIndexOf('.');
		const kind = dot > 0 ? `${name.slice(dot + 1).toUpperCase()} file` : 'File';
		if (size < 1024) return `${kind} · ${size} ${size === 1 ? 'byte' : 'bytes'}`;
		if (size < 1024 * 1024) return `${kind} · ${(size / 1024).toFixed(1)} KB`;
		return `${kind} · ${(size / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="File">
	<div class="flex items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to recordings" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		{#if file.kind === 'audio'}
			<AudioLinesIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		{:else}
			<FileIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		{/if}
		<div class="min-w-0 flex-1">
			<h2 class="truncate text-sm font-medium">{name}</h2>
			<p class="truncate font-mono text-xs text-muted-foreground">{path}</p>
		</div>
		<Button variant="ghost" size="icon-sm" tooltip="Copy path" aria-label="Copy path" onclick={() => void copyPath(path)}>
			<CopyIcon />
		</Button>
	</div>

	{#if file.kind === 'loading' || (file.kind === 'row' && file.slot.kind === 'opening')}
		<Loading class="flex-1" label="Opening {name}…" />
	{:else if file.kind === 'failed'}
		<Empty.Root class="flex-1">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>Could not open this file</Empty.Title>
			<Empty.Description>{file.message}</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void library.open(path)}>Try again</Button>
		</Empty.Root>
	{:else if file.kind === 'row' && file.slot.kind === 'unopened'}
		<Empty.Root class="flex-1">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>Could not open this file</Empty.Title>
			<Empty.Description>{file.slot.message}</Empty.Description>
			<LiveButton variant="outline" size="sm" onclick={() => void library.retryOpen(path)}>Try again</LiveButton>
		</Empty.Root>
	{:else if editing}
		<RowSaveStatus {library} {editing} />
		<div class="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3 sm:px-4">
			{#if editing.view === 'fields'}
				<p class="text-xs text-muted-foreground">
					The transcript’s text, the body of its file. Its fields are kept as they are.
					<LiveButton size="xs" variant="outline" class="ml-1" onclick={() => showSource(true)}>Edit the whole file</LiveButton>
				</p>
				<LiveTextarea class="min-h-40 flex-1 resize-none font-sans" get={() => editing?.bodyText() ?? ''} set={(value) => editing?.setBody(value)} aria-label="Contents of {name}" />
			{:else if editing.view === 'source'}
				<p class="text-xs text-muted-foreground" data-testid="needs-repair">
					{editing.row.status === 'invalid' ? 'The whole file, as its text, until it reads as a transcript again.' : 'The whole file, as its text.'}
					It saves as typed, readable or not.
					<LiveButton size="xs" variant="outline" class="ml-1" onclick={() => showSource(false)}>Edit the text only</LiveButton>
				</p>
				<LiveTextarea
					class="min-h-40 flex-1 resize-none font-mono text-xs"
					get={() => editing?.sourceValue() ?? ''}
					set={(value) => editing?.setText(value)}
					aria-label="Contents of {name}"
					spellcheck={false}
				/>
			{/if}
		</div>
	{:else if text}
		{@const editor = text.editor}
		<SaveStatus {editor} autosavePaused={library.autosave.paused} onDiscardRemoved={() => void library.discardDraft(editor.path)} />
		<div class="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-40 flex-1 resize-none font-mono text-xs"
				value={editor.buffer}
				aria-label="Contents of {name}"
				spellcheck={false}
				oninput={(event) => editor.input(withFileNewlines(event.currentTarget.value, editor.buffer))}
			/>
		</div>
	{:else if file.kind === 'audio'}
		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4 sm:px-4" data-testid="audio-file-view">
			<AudioPlayer source={{ kind: 'file', files: library.folder.files, path, generation: library.generation }} label="Audio in {name}" />
			<dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
				<dt class="text-muted-foreground">Type</dt>
				<dd>{details(file.size)} · {audioMimeTypeOf(path)}</dd>
				<dt class="text-muted-foreground">Recording</dt>
				<dd>
					{#if owner}
						<Button variant="link" class="h-auto p-0" onclick={() => void library.open(owner.path)}>
							{owner.fields.title || owner.path}
						</Button>
					{:else}
						No recording row names this file.
					{/if}
				</dd>
			</dl>
		</div>
	{:else if file.kind === 'binary' || file.kind === 'tooLarge'}
		<Empty.Root class="flex-1">
			<Empty.Media><FileIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>{details(file.size)}</Empty.Title>
			<Empty.Description>
				{file.kind === 'binary'
					? 'This file is not text, so it is listed here but not opened for editing.'
					: 'This text file is larger than 1 MB, so it is not opened in the editor.'}
				Rename, delete, and the terminal still work on it.
			</Empty.Description>
		</Empty.Root>
	{/if}

	<FileNameBar
		prefix={directory === '' ? '' : `${directory}/`}
		{name}
		onRename={(next) => library.rename(path, next)}
		onDelete={() => void confirmDelete(library, path)}
	/>
</section>
