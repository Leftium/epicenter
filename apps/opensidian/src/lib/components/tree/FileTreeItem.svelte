<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import * as TreeView from '@epicenter/ui/tree-view';
	import { getFileIcon } from '$lib/utils/file-icons';
	import { fsState } from '$lib/state/fs-state.svelte';
	import FileTreeItem from './FileTreeItem.svelte';

	let { id }: { id: FileId } = $props();

	const row = $derived(fsState.getRow(id));
	const isFolder = $derived(row?.type === 'folder');
	const isExpanded = $derived(fsState.expandedIds.has(id));
	const isSelected = $derived(fsState.activeFileId === id);
	const children = $derived(isFolder ? fsState.getChildIds(id) : []);
	const isFocused = $derived(fsState.focusedId === id);
</script>

{#if row}
	<ContextMenu.Root>
		<ContextMenu.Trigger>
			{#snippet child({ props })}
				{#if isFolder}
					<div {...props} role="treeitem" aria-expanded={isExpanded}>
						<TreeView.Folder
							name={row.name}
							open={isExpanded}
							onOpenChange={() => fsState.actions.toggleExpand(id)}
							class="w-full rounded-sm px-2 py-1 text-sm hover:bg-accent {isSelected
								? 'bg-accent text-accent-foreground'
								: ''} {isFocused ? 'ring-1 ring-ring' : ''}"
						>
							{#each children as childId (childId)}
								<FileTreeItem id={childId} />
							{/each}
						</TreeView.Folder>
					</div>
				{:else}
					<TreeView.File
						{...props}
						name={row.name}
						{id}
						class="w-full rounded-sm px-2 py-1 text-sm hover:bg-accent {isSelected
							? 'bg-accent text-accent-foreground'
							: ''} {isFocused ? 'ring-1 ring-ring' : ''}"
						onclick={() => fsState.actions.selectFile(id)}
						role="treeitem"
					>
						{#snippet icon()}
							{@const Icon = getFileIcon(row.name)}
							<Icon class="h-4 w-4 shrink-0 text-muted-foreground" />
						{/snippet}
					</TreeView.File>
				{/if}
			{/snippet}
		</ContextMenu.Trigger>
		<ContextMenu.Content>
			{#if isFolder}
				<ContextMenu.Item
					onclick={() => { fsState.actions.selectFile(id); fsState.actions.openCreate('file'); }}
				>
					New File
				</ContextMenu.Item>
				<ContextMenu.Item
					onclick={() => { fsState.actions.selectFile(id); fsState.actions.openCreate('folder'); }}
				>
					New Folder
				</ContextMenu.Item>
				<ContextMenu.Separator />
			{/if}
			<ContextMenu.Item
				onclick={() => { fsState.actions.selectFile(id); fsState.actions.openRename(); }}
			>
				Rename
			</ContextMenu.Item>
			<ContextMenu.Item
				class="text-destructive"
				onclick={() => { fsState.actions.selectFile(id); fsState.actions.openDelete(); }}
			>
				Delete
			</ContextMenu.Item>
		</ContextMenu.Content>
	</ContextMenu.Root>
{/if}
