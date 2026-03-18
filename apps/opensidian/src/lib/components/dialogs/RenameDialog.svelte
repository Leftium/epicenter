<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { Field, FieldLabel } from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { fsState } from '$lib/state/fs-state.svelte';

	let name = $state('');

	// Pre-fill with current name when dialog opens
	$effect(() => {
		if (fsState.renameDialogOpen && fsState.selectedNode) {
			name = fsState.selectedNode.name;
		}
	});

	async function handleSubmit(e: Event) {
		e.preventDefault();
		if (!name.trim() || !fsState.activeFileId) return;

		await fsState.actions.rename(fsState.activeFileId, name.trim());
		fsState.actions.closeRename();
	}

	function handleOpenChange(isOpen: boolean) {
		if (!isOpen) {
			fsState.actions.closeRename();
			name = '';
		}
	}
</script>

<Dialog.Root open={fsState.renameDialogOpen} onOpenChange={handleOpenChange}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Rename</Dialog.Title>
			<Dialog.Description>Enter a new name.</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={handleSubmit}>
			<Field>
				<FieldLabel>Name</FieldLabel>
				<Input type="text" placeholder="new-name" bind:value={name} autofocus />
			</Field>
			<Dialog.Footer class="mt-4">
				<Button
					variant="outline"
					type="button"
					onclick={() => fsState.actions.closeRename()}
				>
					Cancel
				</Button>
				<Button type="submit" disabled={!name.trim()}>Rename</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
