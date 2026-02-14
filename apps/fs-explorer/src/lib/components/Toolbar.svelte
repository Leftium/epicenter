<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Separator } from '@epicenter/ui/separator';
	import { fsState } from '$lib/fs/fs-state.svelte';
	import CreateDialog from './CreateDialog.svelte';
	import DeleteConfirmation from './DeleteConfirmation.svelte';
	import RenameDialog from './RenameDialog.svelte';

	let createDialogOpen = $state(false);
	let createDialogMode = $state<'file' | 'folder'>('file');
	let deleteDialogOpen = $state(false);
	let renameDialogOpen = $state(false);

	function openCreateFile() {
		createDialogMode = 'file';
		createDialogOpen = true;
	}

	function openCreateFolder() {
		createDialogMode = 'folder';
		createDialogOpen = true;
	}

	function openRename() {
		if (!fsState.activeFileId) return;
		renameDialogOpen = true;
	}

	function openDelete() {
		if (!fsState.activeFileId) return;
		deleteDialogOpen = true;
	}
</script>

<div class="flex items-center gap-1 border-b px-2 py-1.5">
	<Button variant="ghost" size="sm" onclick={openCreateFile}>New File</Button>
	<Button variant="ghost" size="sm" onclick={openCreateFolder}>
		New Folder
	</Button>
	<Separator orientation="vertical" class="mx-1 h-4" />
	<Button
		variant="ghost"
		size="sm"
		onclick={openRename}
		disabled={!fsState.activeFileId}
	>
		Rename
	</Button>
	<Button
		variant="ghost"
		size="sm"
		onclick={openDelete}
		disabled={!fsState.activeFileId}
	>
		Delete
	</Button>
</div>

<CreateDialog bind:open={createDialogOpen} mode={createDialogMode} />
<RenameDialog bind:open={renameDialogOpen} />
<DeleteConfirmation bind:open={deleteDialogOpen} />
