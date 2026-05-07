<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import * as TreeView from '@epicenter/ui/tree-view';
	import { getSignedInSession } from '$lib/session.svelte';
	import { getFileIcon } from '$lib/utils/file-icons';
	import FileTreeItem from './FileTreeItem.svelte';
	import InlineNameInput from './InlineNameInput.svelte';

	const signedIn = getSignedInSession();
	let { id }: { id: FileId } = $props();

	const row = $derived(signedIn.opensidian.state.fs.getFile(id));
	const isFolder = $derived(row?.type === 'folder');
	const isExpanded = $derived(signedIn.opensidian.state.fs.isExpanded(id));
	const isSelected = $derived(signedIn.opensidian.state.fs.activeFileId === id);
	const children = $derived(
		isFolder ? signedIn.opensidian.state.fs.getChildren(id) : [],
	);
	const isFocused = $derived(signedIn.opensidian.state.fs.focusedId === id);
	const isRenaming = $derived(signedIn.opensidian.state.fs.renamingId === id);
	const showInlineCreate = $derived(
		signedIn.opensidian.state.fs.inlineCreate?.parentId === id,
	);
	const isContextTarget = $derived(
		signedIn.opensidian.state.fs.contextMenuTargetId === id,
	);

	/** Whether this item should show the highlight background. */
	const isHighlighted = $derived(isSelected || isContextTarget);
</script>

{#if row}
	<ContextMenu.Root
		onOpenChange={(open) => signedIn.opensidian.state.fs.setContextMenuTarget(open ? id: null)}
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
							onConfirm={signedIn.opensidian.state.fs.confirmRename}
							onCancel={signedIn.opensidian.state.fs.cancelRename}
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
							onOpenChange={() => signedIn.opensidian.state.fs.toggleExpand(id)}
							class="w-full rounded-sm px-2 py-1 text-sm hover:bg-accent {isHighlighted
								? 'bg-accent text-accent-foreground'
								: ''} {isFocused ? 'ring-1 ring-ring': ''}"
						>
							{#each children as childId (childId)}
								<FileTreeItem id={childId} />
							{/each}
							{#if showInlineCreate}
								<InlineNameInput
									icon={signedIn.opensidian.state.fs.inlineCreate?.type ?? 'file'}
									onConfirm={signedIn.opensidian.state.fs.confirmCreate}
									onCancel={signedIn.opensidian.state.fs.cancelCreate}
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
							onConfirm={signedIn.opensidian.state.fs.confirmRename}
							onCancel={signedIn.opensidian.state.fs.cancelRename}
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
						onclick={() => signedIn.opensidian.state.fs.selectFile(id)}
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
				if (signedIn.opensidian.state.fs.inlineCreate || signedIn.opensidian.state.fs.renamingId) {
					e.preventDefault();
				}
			}}
		>
			{#if isFolder}
				<ContextMenu.Item
					onclick={() => {
						signedIn.opensidian.state.fs.focus(id);
						signedIn.opensidian.state.fs.expand(id);
						signedIn.opensidian.state.fs.startCreate('file');
					}}
				>
					New File
					<ContextMenu.Shortcut>N</ContextMenu.Shortcut>
				</ContextMenu.Item>
				<ContextMenu.Item
					onclick={() => {
						signedIn.opensidian.state.fs.focus(id);
						signedIn.opensidian.state.fs.expand(id);
						signedIn.opensidian.state.fs.startCreate('folder');
					}}
				>
					New Folder
					<ContextMenu.Shortcut>⇧N</ContextMenu.Shortcut>
				</ContextMenu.Item>
				<ContextMenu.Separator />
			{/if}
			<ContextMenu.Item
				onclick={() => signedIn.opensidian.state.fs.startRename(id)}
			>
				Rename
				<ContextMenu.Shortcut>F2</ContextMenu.Shortcut>
			</ContextMenu.Item>
			<ContextMenu.Item
				class="text-destructive"
				onclick={() => {
					const row = signedIn.opensidian.state.fs.getFile(id);
					const name = row?.name ?? 'this item';
					const isFolder = row?.type === 'folder';
					confirmationDialog.open({
						title: `Delete ${name}?`,
						description:isFolder
							? 'This will delete the folder and all its contents. This action cannot be undone.'
							: 'This will delete the file. This action cannot be undone.',
						confirm: { text: 'Delete', variant: 'destructive' },
						onConfirm: () => signedIn.opensidian.state.fs.deleteFile(id),
					});
				}}
			>
				Delete
				<ContextMenu.Shortcut>⌫</ContextMenu.Shortcut>
			</ContextMenu.Item>
		</ContextMenu.Content>
	</ContextMenu.Root>
{/if}
