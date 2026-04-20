<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import { workspace } from '$lib/client';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import NoteList from '$lib/components/NoteList.svelte';
	import HoneycripSidebar from '$lib/components/Sidebar.svelte';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { foldersState, notesState, viewState } from '$lib/state';

	const bodyHandle = $derived(
		viewState.selectedNoteId
			? workspace.documents.notes.body.get(viewState.selectedNoteId)
			: null,
	);
</script>

<svelte:window
	onkeydown={(e) => {
		const meta = e.metaKey || e.ctrlKey;
		if (!meta) return;

		if (e.key === 'n' && e.shiftKey) {
			e.preventDefault();
			foldersState.createFolder();
		} else if (e.key === 'n') {
			e.preventDefault();
			const { id } = notesState.createNote(viewState.selectedFolderId);
			viewState.selectNote(id);
		}
	}}
/>

<SidebarProvider>
	<HoneycripSidebar />

	<main class="flex h-screen flex-1 overflow-hidden">
		<Resizable.PaneGroup direction="horizontal">
			<Resizable.Pane defaultSize={35} minSize={20}>
				{#if viewState.isRecentlyDeletedView}
					<NoteList
						notes={notesState.deletedNotes}
						title="Recently Deleted"
						showControls={false}
						emptyMessage="No deleted notes"
					/>
				{:else}
					<NoteList
						notes={viewState.filteredNotes}
						title={viewState.folderName}
					/>
				{/if}
			</Resizable.Pane>
			<Resizable.Handle />
			<Resizable.Pane defaultSize={65} minSize={30} class="flex flex-col">
				{#if viewState.selectedNote && bodyHandle}
					{#key viewState.selectedNoteId}
						<HoneycripEditor
							yxmlfragment={bodyHandle.binding}
							onContentChange={(change) => notesState.updateNoteContent(change)}
						/>
					{/key}
				{:else}
					<div class="flex h-full flex-col items-center justify-center gap-2">
						<p class="text-muted-foreground">No note selected</p>
						<p class="text-sm text-muted-foreground/60">
							Choose a note from the list or press ⌘N to create one
						</p>
					</div>
				{/if}
			</Resizable.Pane>
		</Resizable.PaneGroup>
	</main>
</SidebarProvider>

<CommandPalette />
