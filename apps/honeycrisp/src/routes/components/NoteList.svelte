<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import { toast } from '@epicenter/ui/sonner';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { format } from 'date-fns';
	import { inspectRow } from '@epicenter/folder';
	import {
		folderLabel,
		honeycrispDefinition,
		type NoteEntry,
		repairReason,
	} from '$lib/data.js';
	import { getDateLabel } from '$lib/date-label.js';
	import { displayTitle, previewText } from '$lib/note-source.js';
	import type { Notes } from '$lib/notes.svelte.js';
	import { confirmDelete } from './file-actions.js';

	let { notes }: { notes: Notes } = $props();

	const updated = (note: NoteEntry) => note.fields.updatedAt ?? '';
	const isDeleted = (note: NoteEntry) => typeof note.fields.deletedAt === 'string';
	const isPinned = (note: NoteEntry) => note.fields.pinned === true;
	/** A note whose text does not parse, or with a field that needs fixing. */
	const needsRepair = (note: NoteEntry) => repairReason(note) !== undefined;
	/**
	 * Whether `field` read as valid. A list action needs the fields it reads
	 * and text that parses, not a note free of every issue.
	 */
	const reads = (note: NoteEntry, field: keyof NoteEntry['fields']) =>
		note.parseError === undefined && Object.hasOwn(note.fields, field);

	/** What the row shows: the open note's editor when there is one, else the listed file. */
	function shown(note: NoteEntry) {
		const session = notes.noteAt(note.path);
		// An open note is shown as it is on screen, saved or not.
		const reading =
			session === undefined
				? note
				: session.row.status === 'valid'
					? session.row
					: inspectRow(honeycrispDefinition.tables.notes, session.row.text);
		return {
			title: displayTitle(reading.fields.title ?? note.fields.title, reading.body),
			preview: previewText(reading.body),
		};
	}

	const visible = $derived.by(() => {
		const { folderId, deleted, query } = notes.view;
		const needle = query.trim().toLowerCase();
		return notes.notes
			.filter((note) => {
				// A file that needs repair is shown everywhere, so it cannot go missing.
				if (needsRepair(note)) return !deleted;
				if (isDeleted(note) !== deleted) return false;
				if (!deleted && folderId !== null && note.fields.folderId !== folderId) return false;
				if (needle === '') return true;
				return `${note.fields.title}\n${note.body}`.toLowerCase().includes(needle);
			})
			.toSorted((a, b) => updated(b).localeCompare(updated(a)));
	});

	const heading = $derived.by(() => {
		if (notes.view.deleted) return 'Recently Deleted';
		const id = notes.view.folderId;
		if (id === null) return 'All Notes';
		const folder = notes.folders.find((item) => item.stem === id);
		return folder === undefined ? 'Notes' : folderLabel(folder);
	});

	const groups = $derived.by(() => {
		const result: { label: string; entries: NoteEntry[] }[] = [];
		const push = (label: string, note: NoteEntry) => {
			const last = result.at(-1);
			if (last?.label === label) last.entries.push(note);
			else result.push({ label, entries: [note] });
		};
		for (const note of visible.filter(needsRepair)) push('Needs repair', note);
		for (const note of visible.filter((item) => !needsRepair(item) && isPinned(item)))
			push('Pinned', note);
		for (const note of visible.filter((item) => !needsRepair(item) && !isPinned(item)))
			push(updated(note) === '' ? 'Undated' : getDateLabel(updated(note)), note);
		return result;
	});

	async function report(action: string, problem: Promise<string | undefined>) {
		const message = await problem;
		if (message) toast.error(`Could not ${action}`, { description: message });
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Notes">
	<div class="flex h-11 shrink-0 items-center justify-between border-b px-3">
		<div class="flex items-center gap-2">
			<h2 class="text-sm font-semibold">{heading}</h2>
			<span class="text-xs text-muted-foreground">{visible.length}</span>
		</div>
		{#if !notes.view.deleted}
			<Button
				variant="ghost"
				size="icon-sm"
				tooltip="New note (⌘N)"
				aria-label="New note"
				onclick={() => void report('create the note', notes.createNote())}
			>
				<PlusIcon />
			</Button>
		{/if}
	</div>

	{#if notes.listError}
		<p class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive" role="status">
			Could not read the notes: {notes.listError}. Showing the last list that was read.
		</p>
	{/if}

	<div class="min-h-0 flex-1 overflow-y-auto p-2">
		{#if visible.length === 0}
			<p class="p-6 text-center text-sm text-muted-foreground">
				{notes.view.deleted ? 'No deleted notes' : 'No notes here yet. Press + to create one.'}
			</p>
		{/if}
		{#each groups as group (group.label)}
			<h3 class="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{group.label}</h3>
			{#each group.entries as note (note.path)}
				{@const row = shown(note)}
				{@const session = notes.noteAt(note.path)}
				<ContextMenu.Root>
					<ContextMenu.Trigger>
						<button
							class="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-accent/40"
							class:bg-accent={notes.selectedPath === note.path}
							data-note={note.path}
							aria-current={notes.selectedPath === note.path ? 'true' : undefined}
							onclick={() => void notes.open(note.path)}
						>
							<span class="flex items-start justify-between gap-2">
								<span class="line-clamp-1 text-sm font-medium">
									{#if isPinned(note)}<PinIcon class="mr-1 inline size-3 fill-current align-baseline" />{/if}
									{row.title}
								</span>
								<span class="shrink-0 text-xs text-muted-foreground">
									{#if session?.status === 'conflict' || session?.status === 'failed'}
										<span class="text-destructive">not saved</span>
									{:else if session?.status === 'unconfirmed'}
										<span class="text-warning">not confirmed</span>
									{:else if session?.unsettled}
										draft
									{:else if updated(note) !== ''}
										{format(new Date(updated(note)), 'h:mm a')}
									{/if}
								</span>
							</span>
							<span class="line-clamp-2 text-xs text-muted-foreground">
								{repairReason(note) ?? (row.preview || 'No text')}
							</span>
						</button>
					</ContextMenu.Trigger>
					<ContextMenu.Content class="w-52">
						{#if notes.fenced}
							<!-- An open menu is outside the app's inert root. -->
							<ContextMenu.Item disabled>The app is closing</ContextMenu.Item>
						{:else}
							{#if needsRepair(note)}
								<ContextMenu.Item onSelect={() => void notes.open(note.path)}>Open to repair</ContextMenu.Item>
							{/if}
							<!-- Each action needs text that parses and the fields it reads. -->
							{#if isDeleted(note)}
								<ContextMenu.Item onSelect={() => void report('restore the note', notes.restoreNote(note.path))}>
									Restore
								</ContextMenu.Item>
							{:else if note.parseError === undefined}
								{#if reads(note, 'pinned')}
									<ContextMenu.Item
										onSelect={() =>
											void report('pin the note', notes.patchNote(note.path, { pinned: !isPinned(note) }))}
									>
										{isPinned(note) ? 'Unpin' : 'Pin'}
									</ContextMenu.Item>
								{/if}
								<ContextMenu.Sub>
									<ContextMenu.SubTrigger>Move to folder</ContextMenu.SubTrigger>
									<ContextMenu.SubContent class="w-48">
										<ContextMenu.Item
											onSelect={() => void report('move the note', notes.patchNote(note.path, { folderId: null }))}
										>
											No folder
										</ContextMenu.Item>
										<ContextMenu.Separator />
										{#each notes.folders as folder (folder.path)}
											<ContextMenu.Item
												onSelect={() =>
													void report('move the note', notes.patchNote(note.path, { folderId: folder.stem }))}
											>
												{folderLabel(folder)}
											</ContextMenu.Item>
										{/each}
									</ContextMenu.SubContent>
								</ContextMenu.Sub>
								<!-- Not known to be outside Recently Deleted unless deletedAt validated. -->
								{#if reads(note, 'deletedAt')}
									<ContextMenu.Separator />
									<ContextMenu.Item
										variant="destructive"
										onSelect={() => void report('delete the note', notes.trashNote(note.path))}
									>
										Move to Recently Deleted
									</ContextMenu.Item>
								{/if}
							{/if}
							{#if isDeleted(note)}
								<ContextMenu.Item variant="destructive" onSelect={() => void confirmDelete(notes, note.path)}>
									Delete permanently…
								</ContextMenu.Item>
							{:else if needsRepair(note)}
								<ContextMenu.Item variant="destructive" onSelect={() => void confirmDelete(notes, note.path)}>
									Delete file…
								</ContextMenu.Item>
							{/if}
						{/if}
					</ContextMenu.Content>
				</ContextMenu.Root>
			{/each}
		{/each}

		{#if notes.unreadable.length > 0}
			<h3 class="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">Cannot be read as text</h3>
			{#each notes.unreadable as item (item.path)}
				<div class="rounded-lg px-3 py-2">
					<p class="font-mono text-xs">{item.path}</p>
					<p class="text-xs text-muted-foreground">{item.message}</p>
				</div>
			{/each}
			<p class="px-3 pt-1 text-xs text-muted-foreground">
				These files are still in the folder. Repair or remove them from Files or the terminal.
			</p>
		{/if}
	</div>
</section>
