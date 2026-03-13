<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as ScrollArea from '@epicenter/ui/scroll-area';
	import ArrowUpDownIcon from '@lucide/svelte/icons/arrow-up-down';
	import CheckIcon from '@lucide/svelte/icons/check';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { differenceInDays, format, isToday, isYesterday } from 'date-fns';
	import NoteCard from '$lib/components/NoteCard.svelte';
	import type { Folder, FolderId, Note, NoteId } from '$lib/workspace';

	let {
		notes,
		selectedNoteId,
		sortBy,
		onSelectNote,
		onCreateNote,
		onDeleteNote,
		onPinNote,
		onSortChange,
		viewMode = 'normal' as 'normal' | 'recentlyDeleted',
		onRestoreNote = undefined as ((noteId: NoteId) => void) | undefined,
		onPermanentlyDeleteNote = undefined as
			| ((noteId: NoteId) => void)
			| undefined,
		onMoveToFolder = undefined as
			| ((noteId: NoteId, folderId: FolderId | undefined) => void)
			| undefined,
		folderName = 'Notes',
		folders = [] as Folder[],
	}: {
		notes: Note[];
		selectedNoteId: NoteId | null;
		sortBy: 'dateEdited' | 'dateCreated' | 'title';
		onSelectNote: (noteId: NoteId) => void;
		onCreateNote: () => void;
		onDeleteNote: (noteId: NoteId) => void;
		onPinNote: (noteId: NoteId) => void;
		onSortChange: (sortBy: 'dateEdited' | 'dateCreated' | 'title') => void;
		viewMode?: 'normal' | 'recentlyDeleted';
		onRestoreNote?: ((noteId: NoteId) => void) | undefined;
		onPermanentlyDeleteNote?: ((noteId: NoteId) => void) | undefined;
		onMoveToFolder?:
			| ((noteId: NoteId, folderId: FolderId | undefined) => void)
			| undefined;
		folderName?: string;
		folders?: Folder[];
	} = $props();

	function parseDateTime(dts: string): Date {
		return new Date(dts.split('|')[0]!);
	}

	function getDateLabel(dts: string): string {
		const date = parseDateTime(dts);
		if (isToday(date)) return 'Today';
		if (isYesterday(date)) return 'Yesterday';
		const daysAgo = differenceInDays(new Date(), date);
		if (daysAgo <= 7) return 'Previous 7 Days';
		if (daysAgo <= 30) return 'Previous 30 Days';
		return format(date, 'MMMM yyyy');
	}

	const groupedNotes = $derived.by(() => {
		const pinned = notes
			.filter((n) => n.pinned)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

		const unpinned = notes
			.filter((n) => !n.pinned)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

		const groups: { label: string; entries: Note[] }[] = [];

		if (pinned.length > 0) {
			groups.push({ label: 'Pinned', entries: pinned });
		}

		let currentLabel = '';
		let currentGroup: Note[] = [];

		for (const note of unpinned) {
			const label = getDateLabel(note.updatedAt);
			if (label !== currentLabel) {
				if (currentGroup.length > 0) {
					groups.push({ label: currentLabel, entries: currentGroup });
				}
				currentLabel = label;
				currentGroup = [note];
			} else {
				currentGroup.push(note);
			}
		}

		if (currentGroup.length > 0) {
			groups.push({ label: currentLabel, entries: currentGroup });
		}

		return groups;
	});
</script>

<div class="flex h-full flex-col">
	<div class="flex items-center justify-between border-b px-4 py-3">
		<div class="flex items-center gap-2">
			<h2 class="text-sm font-semibold">{folderName}</h2>
			<span class="text-xs text-muted-foreground">{notes.length}</span>
		</div>
		{#if viewMode === 'normal'}
			<div class="flex items-center gap-1">
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button variant="ghost" size="icon" class="size-7" {...props}>
								<ArrowUpDownIcon class="size-4" />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-44">
						<DropdownMenu.Item onclick={() => onSortChange('dateEdited')}>
							{#if sortBy === 'dateEdited'}
								<CheckIcon class="mr-2 size-4" />
							{:else}
								<span class="mr-2 size-4"></span>
							{/if}
							Date Edited
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={() => onSortChange('dateCreated')}>
							{#if sortBy === 'dateCreated'}
								<CheckIcon class="mr-2 size-4" />
							{:else}
								<span class="mr-2 size-4"></span>
							{/if}
							Date Created
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={() => onSortChange('title')}>
							{#if sortBy === 'title'}
								<CheckIcon class="mr-2 size-4" />
							{:else}
								<span class="mr-2 size-4"></span>
							{/if}
							Title
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					onclick={onCreateNote}
				>
					<PlusIcon class="size-4" />
				</Button>
			</div>
		{/if}
	</div>

	<ScrollArea.Root class="flex-1">
		{#if notes.length === 0}
			<div
				class="flex h-full items-center justify-center p-8 text-center text-muted-foreground"
			>
				<p class="text-sm">
					{#if viewMode === 'recentlyDeleted'}
						No deleted notes
					{:else}
						No notes yet. Click + to create one.
					{/if}
				</p>
			</div>
		{:else}
			<div class="flex flex-col gap-4 p-2">
				{#each groupedNotes as group}
					<div class="flex flex-col gap-0.5">
						<h3 class="px-2 pb-1 text-xs font-medium text-muted-foreground">
							{group.label}
						</h3>
						{#each group.entries as note (note.id)}
							<NoteCard
								{note}
								isSelected={selectedNoteId === note.id}
								{viewMode}
								{folders}
								onSelect={() => onSelectNote(note.id)}
								onPin={() => onPinNote(note.id)}
								onDelete={() => onDeleteNote(note.id)}
								onRestore={() => onRestoreNote?.(note.id)}
								onPermanentlyDelete={() => onPermanentlyDeleteNote?.(note.id)}
								onMoveToFolder={(folderId) => onMoveToFolder?.(note.id, folderId)}
							/>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	</ScrollArea.Root>
</div>
