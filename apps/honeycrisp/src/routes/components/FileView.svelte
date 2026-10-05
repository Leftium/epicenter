<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileIcon from '@lucide/svelte/icons/file';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { basename, dirname, withFileNewlines } from '@epicenter/folder/file-browser';
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

	async function copyText(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast.success('Copied your text');
		} catch {
			toast.error('Could not copy your text', { description: 'Select it below and copy it from there.' });
		}
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
	{:else if file.kind === 'unopened'}
		<!-- The person's text, kept exactly as it was saved until the note opens or they dismiss it. -->
		<div class="flex flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs">
			<span class="text-destructive" role="alert">{file.message} Your text is kept below, exactly as saved.</span>
			<Button
				size="xs"
				variant="outline"
				disabled={notes.fenced}
				onclick={async () => {
					const problem = await notes.reopen(path);
					if (problem) toast.error('Could not open the note', { description: problem });
				}}
			>
				Try opening again
			</Button>
			<Button size="xs" variant="ghost" onclick={() => void copyText(file.text)}>Copy text</Button>
			<Button size="xs" variant="ghost-destructive" disabled={notes.fenced} onclick={() => notes.dismiss(path)}>
				Stop keeping this text
			</Button>
		</div>
		<div class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-40 flex-1 resize-none font-mono text-xs"
				value={file.text}
				readonly
				aria-label="Your saved text, read-only"
				spellcheck={false}
			/>
		</div>
	{:else if file.kind === 'text'}
		{@const session = file.session}
		<DraftStatus
			{session}
			onRecover={() => notes.recoverDraft(session.path)}
			onDiscard={() => void notes.discardDraft(session.path)}
			onStopTracking={() => notes.stopTracking(session.path)}
		/>
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
