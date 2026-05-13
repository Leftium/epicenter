<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import * as TreeView from '@epicenter/ui/tree-view';
	import { requireApp } from '$lib/session';
	import { getFileIcon } from '$lib/utils/file-icons';
	import FileTreeItem from './FileTreeItem.svelte';
	import InlineNameInput from './InlineNameInput.svelte';

	const app = requireApp();
	let { id }: { id: FileId } = $props();

	const row = $derived(app.state.files.getFile(id));
	const isFolder = $derived(row?.type === 'folder');
	const isExpanded = $derived(app.state.files.isExpanded(id));
	const isSelected = $derived(app.state.files.activeFileId === id);
	const children = $derived(
		isFolder ? app.state.files.getChildren(id) : [],
	);
	const isFocused = $derived(app.state.files.focusedId === id);
	const isRenaming = $derived(app.state.files.renamingId === id);
	const showInlineCreate = $derived(
		app.state.files.inlineCreate?.parentId === id,
	);
	const isContextTarget = $derived(
		app.state.files.contextMenuTargetId === id,
	);

	/** Whether this item should show the highlight background. */
	const isHighlighted = $derived(isSelected || isContextTarget);
</script>

{#if row}
	<ContextMenu.Root
		onOpenChange={(open) => app.state.files.setContextMenuTarget(open ? id: null)}
	>
		<ContextMenu.Trigger>
			{#snippet child({ props })}
				{#if isFolder && isRenaming}
					<div
						{...props}
						role="treeitem"
						aria-selected={isSelected}
						aria-expanded={isExpanded}
						class="w-full"
					>
						<InlineNameInput
							defaultValue={row.name}
							icon="folder"
							onConfirm={app.state.files.confirmRename}
							onCancel={app.state.files.cancelRename}
						/>
					</div>
				{:else if isFolder}
					<div
						{...props}
						role="treeitem"
						aria-selected={isSelected}
						aria-expanded={isExpanded}
					>
						<TreeView.Folder
							name={row.name}
							open={isExpanded}
							onOpenChange={() => app.state.files.toggleExpand(id)}
							class="w-full rounded-sm px-2 py-1 text-sm hover:bg-accent {isHighlighted
								? 'bg-accent text-accent-foreground'
								: ''} {isFocused ? 'ring-1 ring-ring': ''}"
						>
							{#each children as childId (childId)}
								<FileTreeItem id={childId} />
							{/each}
							{#if showInlineCreate}
								<InlineNameInput
									icon={app.state.files.inlineCreate?.type ?? 'file'}
									onConfirm={app.state.files.confirmCreate}
									onCancel={app.state.files.cancelCreate}
								/>
							{/if}
						</TreeView.Folder>
					</div>
				{:else if isRenaming}
					<div
						{...props}
						role="treeitem"
						aria-selected={isSelected}
						class="w-full"
					>
						<InlineNameInput
							defaultValue={row.name}
							icon="file"
							onConfirm={app.state.files.confirmRename}
							onCancel={app.state.files.cancelRename}
						/>
					</div>
				{:else}
					<TreeView.File
						{...props}
						name={row.name}
						{id}
						class="w-full rounded-sm px-2 py-1 text-sm hover:bg-accent {isHighlighted
							? 'bg-accent text-accent-foreground'
							: ''} {isFocused ? 'ring-1 ring-ring': ''}"
						onclick={() => app.state.files.selectFile(id)}
						aria-selected={isSelected}
						role="treeitem"
					>
						{#snippet icon()}
							{@const Icon = getFileIcon(row.name)}
							<Icon
								aria-hidden="true"
								class="h-4 w-4 shrink-0 text-muted-foreground"
							/>
						{/snippet}
					</TreeView.File>
				{/if}
			{/snippet}
		</ContextMenu.Trigger>
		<ContextMenu.Content
			onCloseAutoFocus={(e) => {
				if (app.state.files.inlineCreate || app.state.files.renamingId) {
					e.preventDefault();
				}
			}}
		>
			{#if isFolder}
				<ContextMenu.Item
					onclick={() => {
						app.state.files.focus(id);
						app.state.files.expand(id);
						app.state.files.startCreate('file');
					}}
				>
					New File
					<ContextMenu.Shortcut>N</ContextMenu.Shortcut>
				</ContextMenu.Item>
				<ContextMenu.Item
					onclick={() => {
						app.state.files.focus(id);
						app.state.files.expand(id);
						app.state.files.startCreate('folder');
					}}
				>
					New Folder
					<ContextMenu.Shortcut>⇧N</ContextMenu.Shortcut>
				</ContextMenu.Item>
				<ContextMenu.Separator />
			{/if}
			<ContextMenu.Item onclick={() => app.state.files.startRename(id)}>
				Rename
				<ContextMenu.Shortcut>F2</ContextMenu.Shortcut>
			</ContextMenu.Item>
			<ContextMenu.Item
				class="text-destructive"
				onclick={() => {
					const row = app.state.files.getFile(id);
					const name = row?.name ?? 'this item';
					const isFolder = row?.type === 'folder';
					confirmationDialog.open({
						title: `Delete ${name}?`,
						description:isFolder
							? 'This will delete the folder and all its contents. This action cannot be undone.'
							: 'This will delete the file. This action cannot be undone.',
						confirm: { text: 'Delete', variant: 'destructive' },
						onConfirm: () => app.state.files.deleteFile(id),
					});
				}}
			>
				Delete
				<ContextMenu.Shortcut>⌫</ContextMenu.Shortcut>
			</ContextMenu.Item>
		</ContextMenu.Content>
	</ContextMenu.Root>
{/if}
