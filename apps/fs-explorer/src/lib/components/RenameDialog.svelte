<script lang="ts">
	import * as Dialog from '@epicenter/ui/dialog';
	import { Button } from '@epicenter/ui/button';
	import { fsState } from '$lib/fs/fs-state.svelte';

	type Props = {
		open: boolean;
	};

	let { open = $bindable(false) }: Props = $props();
	let name = $state('');

	// Pre-fill with current name when dialog opens
	$effect(() => {
		if (open && fsState.selectedNode) {
			name = fsState.selectedNode.name;
		}
	});

	async function handleSubmit(e: Event) {
		e.preventDefault();
		if (!name.trim() || !fsState.activeFileId) return;

		await fsState.actions.rename(fsState.activeFileId, name.trim());
		open = false;
	}

	function handleOpenChange(isOpen: boolean) {
		open = isOpen;
		if (!isOpen) name = '';
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Rename</Dialog.Title>
			<Dialog.Description>Enter a new name.</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={handleSubmit}>
			<input
				class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				type="text"
				placeholder="new-name"
				bind:value={name}
				autofocus
			/>
			<Dialog.Footer class="mt-4">
				<Button variant="outline" type="button" onclick={() => (open = false)}>
					Cancel
				</Button>
				<Button type="submit" disabled={!name.trim()}>Rename</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
