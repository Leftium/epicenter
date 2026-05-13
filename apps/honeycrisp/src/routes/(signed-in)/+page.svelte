<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import { requireWorkspace } from '$lib/session';
	import CommandPalette from './components/CommandPalette.svelte';
	import NoteBodyPane from './components/NoteBodyPane.svelte';
	import NoteList from './components/NoteList.svelte';
	import HoneycripSidebar from './components/Sidebar.svelte';

	const workspace = requireWorkspace();
</script>

<svelte:window
	onkeydown={(e) => {
		const meta = e.metaKey || e.ctrlKey;
		if (!meta) return;

		if (e.key === 'n' && e.shiftKey) {
			e.preventDefault();
			workspace.state.folders.create();
		} else if (e.key === 'n') {
			e.preventDefault();
			const { id } = workspace.state.notes.create(workspace.state.view.selectedFolderId);
			workspace.state.view.selectNote(id);
		}
	}}
/>

<SidebarProvider>
	<HoneycripSidebar />

	<main class="flex h-screen flex-1 overflow-hidden">
		<Resizable.PaneGroup direction="horizontal">
			<Resizable.Pane defaultSize={35} minSize={20}>
				<NoteList />
			</Resizable.Pane>
			<Resizable.Handle />
			<Resizable.Pane defaultSize={65} minSize={30} class="flex flex-col">
				{#if workspace.state.view.selectedNote && workspace.state.view.selectedNoteId}
					{#key workspace.state.view.selectedNoteId}
						<NoteBodyPane noteId={workspace.state.view.selectedNoteId} />
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
