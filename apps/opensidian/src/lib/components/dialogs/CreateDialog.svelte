<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { Field, FieldLabel } from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { fsState } from '$lib/state/fs-state.svelte';

	let name = $state('');

	const title = $derived(
		fsState.createDialogMode === 'file' ? 'New File' : 'New Folder',
	);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		if (!name.trim()) return;

		const parentId =
			fsState.selectedNode?.type === 'folder' ? fsState.activeFileId : null;

		if (fsState.createDialogMode === 'file') {
			await fsState.actions.createFile(parentId, name.trim());
		} else {
			await fsState.actions.createFolder(parentId, name.trim());
		}

		name = '';
		fsState.actions.closeCreate();
	}

	function handleOpenChange(isOpen: boolean) {
		if (!isOpen) {
			fsState.actions.closeCreate();
			name = '';
		}
	}
</script>

<Dialog.Root open={fsState.createDialogOpen} onOpenChange={handleOpenChange}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description>
				Enter a name for the new {fsState.createDialogMode}.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={handleSubmit}>
			<Field>
				<FieldLabel>Name</FieldLabel>
				<Input
					type="text"
					placeholder={fsState.createDialogMode === 'file' ? 'filename.txt' : 'folder-name'}
					bind:value={name}
					autofocus
				/>
			</Field>
			<Dialog.Footer class="mt-4">
				<Button
					variant="outline"
					type="button"
					onclick={() => fsState.actions.closeCreate()}
				>
					Cancel
				</Button>
				<Button type="submit" disabled={!name.trim()}>Create</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
