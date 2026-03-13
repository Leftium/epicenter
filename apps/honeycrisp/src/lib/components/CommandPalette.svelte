<script lang="ts">
	import * as Command from '@epicenter/ui/command';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import type { Folder, FolderId, Note, NoteId } from '$lib/workspace';

	let {
		open = $bindable(false),
		notes,
		folders,
		onSelectNote,
		onSelectFolder,
		onCreateNote,
		onCreateFolder,
	}: {
		open: boolean;
		notes: Note[];
		folders: Folder[];
		onSelectNote: (noteId: NoteId) => void;
		onSelectFolder: (folderId: FolderId | null) => void;
		onCreateNote: () => void;
		onCreateFolder: () => void;
	} = $props();
</script>

<Command.Dialog bind:open>
	<Command.Input placeholder="Search notes..." />
	<Command.List>
		<Command.Empty>No results found.</Command.Empty>

		<Command.Group heading="Folders">
			<Command.Item
				onSelect={() => {
					onSelectFolder(null);
					open = false;
				}}
			>
				<FileTextIcon class="mr-2 size-4" />
				All Notes
			</Command.Item>
			{#each folders as folder (folder.id)}
				<Command.Item
					onSelect={() => {
						onSelectFolder(folder.id);
						open = false;
					}}
				>
					{#if folder.icon}
						<span class="mr-2 text-base leading-none">{folder.icon}</span>
					{:else}
						<FolderIcon class="mr-2 size-4" />
					{/if}
					{folder.name}
				</Command.Item>
			{/each}
		</Command.Group>

		<Command.Separator />

		<Command.Group heading="Notes">
			{#each notes as note (note.id)}
				<Command.Item
					onSelect={() => {
						onSelectNote(note.id);
						open = false;
					}}
				>
					<FileTextIcon class="mr-2 size-4" />
					<div class="flex flex-col">
						<span>{note.title || 'Untitled'}</span>
						{#if note.preview}
							<span class="text-muted-foreground line-clamp-1 text-xs"
								>{note.preview}</span
							>
						{/if}
					</div>
				</Command.Item>
			{/each}
		</Command.Group>

		<Command.Separator />

		<Command.Group heading="Actions">
			<Command.Item
				onSelect={() => {
					onCreateNote();
					open = false;
				}}
			>
				<PlusIcon class="mr-2 size-4" />
				New Note
			</Command.Item>
			<Command.Item
				onSelect={() => {
					onCreateFolder();
					open = false;
				}}
			>
				<FolderPlusIcon class="mr-2 size-4" />
				New Folder
			</Command.Item>
		</Command.Group>
	</Command.List>
</Command.Dialog>
