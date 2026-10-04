<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileIcon from '@lucide/svelte/icons/file';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { inspectRow } from '@epicenter/folder';
	import { honeycrispDefinition, instantNow, noteIdOf } from '$lib/data.js';
	import { basename, dirname, withFileNewlines } from '$lib/files.js';
	import { fieldDefaults, repairFields } from '$lib/note-source.js';
	import type { Notes, OpenFile } from '$lib/notes.svelte.js';
	import { confirmDelete, copyPath } from './file-actions.js';
	import FileNameBar from './FileNameBar.svelte';
	import DraftStatus from './DraftStatus.svelte';

	let {
		notes,
		path,
		file,
	}: {
		notes: Notes;
		path: string;
		file: OpenFile;
	} = $props();

	const name = $derived(basename(path));
	const directory = $derived(dirname(path));
	/**
	 * How a note file open as text reads, from the text on screen and never
	 * from the saved file. Undefined for any other file.
	 */
	const noteText = $derived(
		file.kind === 'text' && noteIdOf(path) !== undefined
			? inspectRow(honeycrispDefinition.tables.notes, file.session.buffer)
			: undefined,
	);
	const defaults = $derived(noteText && fieldDefaults(noteText, instantNow()));

	function fillDefaults() {
		if (file.kind !== 'text' || defaults === undefined) return;
		const repaired = repairFields(file.session.buffer, defaults);
		if (repaired.error !== null)
			return void toast.error('Could not set the fields', { description: repaired.error });
		file.session.input(repaired.data);
	}

	async function openAsNote() {
		const problem = await notes.openAsNote(path);
		if (problem) toast.error('Could not open it as a note', { description: problem });
	}

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
		<FileIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<div class="min-w-0 flex-1">
			<h2 class="truncate text-sm font-medium">{name}</h2>
			<p class="truncate font-mono text-xs text-muted-foreground">{path}</p>
		</div>
		<Button variant="ghost" size="icon-sm" tooltip="Copy path" aria-label="Copy path" onclick={() => void copyPath(path)}>
			<CopyIcon />
		</Button>
	</div>

	{#if file.kind === 'loading'}
		<Loading class="flex-1" label="Opening {name}…" />
	{:else if file.kind === 'failed'}
		<Empty.Root class="flex-1">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>Could not open this file</Empty.Title>
			<Empty.Description>{file.message}</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void notes.open(path)}>Try again</Button>
		</Empty.Root>
	{:else if file.kind === 'text'}
		{@const session = file.session}
		<DraftStatus
			{session}
			noun={noteText ? 'note' : 'file'}
			onRecover={() => notes.recoverDraft(session.path)}
			onDiscard={() => notes.discardDraft(session.path)}
			onStopTracking={() => notes.stopTracking(session.path)}
		/>
		{#if noteText}
			{@const repaired = noteText.parseError === undefined && noteText.issues.length === 0}
			<!-- A note file open as text: what stands between this text and the note editor. -->
			<div class="border-b px-4 py-2 text-xs {repaired ? '' : 'bg-destructive/5'}">
				<p class="flex flex-wrap items-center gap-2 font-medium">
					{#if noteText.parseError}
						<Badge variant="destructive">Needs repair</Badge>
						{noteText.parseError.message}. Fix the text below.
					{:else if noteText.issues.length > 0}
						<Badge variant="destructive">Needs repair</Badge>
						Some fields need fixing.
						{#if defaults}
							<Button size="xs" variant="outline" onclick={fillDefaults}>Set these fields to their defaults</Button>
						{/if}
					{:else if file.refusal}
						When it was opened, this note used text the note editor cannot rewrite ({file.refusal}).
					{:else}
						This note is open as a file.
					{/if}
					<Button size="xs" variant="outline" disabled={!repaired || session.status !== 'saved'} onclick={openAsNote}>
						Open as note
					</Button>
				</p>
				{#if noteText.parseError}
					<ul class="mt-1 space-y-0.5 text-muted-foreground">
						{#each noteText.parseError.diagnostics as diagnostic, index (index)}
							{#if diagnostic.message !== noteText.parseError.message}<li>{diagnostic.message}</li>{/if}
						{/each}
					</ul>
				{:else if noteText.issues.length > 0}
					<ul class="mt-1 space-y-0.5 text-muted-foreground">
						{#each noteText.issues as issue, index (index)}
							<li>{issue.message}</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
		<div class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-40 flex-1 resize-none font-mono text-xs"
				value={session.buffer}
				aria-label="Contents of {name}"
				spellcheck={false}
				oninput={(event) => session.input(withFileNewlines(event.currentTarget.value, session.buffer))}
			/>
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
		onRename={(next) => notes.rename(path, next)}
		onDelete={() => void confirmDelete(notes, path)}
	/>
</section>
