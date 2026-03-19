<script lang="ts">
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button } from '@epicenter/ui/button';
	import { fsState } from '$lib/state/fs-state.svelte';

	const nodeName = $derived(fsState.selectedNode?.name ?? 'this item');
	const nodeType = $derived(fsState.selectedNode?.type ?? 'file');

	async function handleDelete() {
		if (!fsState.activeFileId) return;
		await fsState.deleteFile(fsState.activeFileId);
		fsState.closeDelete();
	}

	function handleOpenChange(isOpen: boolean) {
		if (!isOpen) fsState.closeDelete();
	}
</script>

<AlertDialog.Root
	open={fsState.deleteDialogOpen}
	onOpenChange={handleOpenChange}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete {nodeName}?</AlertDialog.Title>
			<AlertDialog.Description>
				{#if nodeType === 'folder'}
					This will delete the folder and all its contents. This action cannot
					be undone.
				{:else}
					This will delete the file. This action cannot be undone.
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<Button variant="destructive" onclick={handleDelete}>Delete</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
