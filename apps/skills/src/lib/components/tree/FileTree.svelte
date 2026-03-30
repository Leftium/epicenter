<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import * as Empty from '@epicenter/ui/empty';
	import * as TreeView from '@epicenter/ui/tree-view';
	import { fsState } from '$lib/state/fs-state.svelte';
	import FileTreeItem from './FileTreeItem.svelte';
	import InlineNameInput from './InlineNameInput.svelte';

	/**
	 * Flat list of visible item IDs in visual order.
	 * Respects folder expansion state—collapsed folders hide their descendants.
	 */
	const visibleIds = $derived.by(() => {
		return fsState.walkTree<FileId>((id, row) => ({
			collect: id,
			descend: row.type === 'folder' && fsState.expandedIds.has(id),
		}));
	});

	/** Whether an inline create/rename is active (suppresses tree keyboard shortcuts). */
	const isEditing = $derived(
		fsState.inlineCreate !== null || fsState.renamingId !== null,
	);

	function handleKeydown(e: KeyboardEvent) {
		if (isEditing) return;

		const focused = fsState.focusedId;
		const idx = focused ? visibleIds.indexOf(focused) : -1;

		switch (e.key) {
			case 'ArrowDown': {
				e.preventDefault();
				const next = visibleIds[idx + 1] ?? visibleIds[0];
				if (next) fsState.focus(next);
				break;
			}
			case 'ArrowUp': {
				e.preventDefault();
				const prev = visibleIds[idx - 1] ?? visibleIds.at(-1);
				if (prev) fsState.focus(prev);
				break;
			}
			case 'ArrowRight': {
				if (!focused) break;
				const row = fsState.getRow(focused);
				if (row?.type === 'folder' && !fsState.expandedIds.has(focused)) {
					fsState.toggleExpand(focused);
				}
				break;
			}
			case 'ArrowLeft': {
				if (!focused) break;
				const row = fsState.getRow(focused);
				if (row?.type === 'folder' && fsState.expandedIds.has(focused)) {
					fsState.toggleExpand(focused);
				}
				break;
			}
			case 'Enter': {
				if (focused) fsState.selectFile(focused);
				break;
			}
			case 'F2': {
				if (focused) fsState.startRename(focused);
				break;
			}
			case 'Delete':
			case 'Backspace': {
				if (focused) {
					fsState.selectFile(focused);
					fsState.openDelete();
				}
				break;
			}
		}
	}
</script>

{#if fsState.rootChildIds.length === 0 && !fsState.inlineCreate}
	<Empty.Root class="border-0">
		<Empty.Header>
			<Empty.Title>No skills yet</Empty.Title>
			<Empty.Description
				>Use the toolbar to create a new skill</Empty.Description
			>
		</Empty.Header>
	</Empty.Root>
{:else}
	<TreeView.Root
		tabindex={0}
		aria-label="Skill explorer"
		onkeydown={handleKeydown}
	>
		{#each fsState.rootChildIds as childId (childId)}
			<FileTreeItem id={childId} />
		{/each}
		{#if fsState.inlineCreate?.parentId === null}
			<InlineNameInput
				icon={fsState.inlineCreate.type}
				onConfirm={fsState.confirmCreate}
				onCancel={fsState.cancelCreate}
			/>
		{/if}
	</TreeView.Root>
{/if}
