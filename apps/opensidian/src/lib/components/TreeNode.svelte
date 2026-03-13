<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import { ChevronRight, File as FileIcon, Folder, FolderOpen } from 'lucide-svelte';
	import { fsState } from '$lib/fs/fs-state.svelte';
	import CreateDialog from './CreateDialog.svelte';
	import DeleteConfirmation from './DeleteConfirmation.svelte';
	import RenameDialog from './RenameDialog.svelte';
	import TreeNode from './TreeNode.svelte';

	type Props = {
		id: FileId;
		depth: number;
	};

	let { id, depth }: Props = $props();

	const row = $derived(fsState.getRow(id));
	const isFolder = $derived(row?.type === 'folder');
	const isExpanded = $derived(fsState.expandedIds.has(id));
	const isSelected = $derived(fsState.activeFileId === id);
	const children = $derived(isFolder ? fsState.getChildIds(id) : []);

	let createDialogOpen = $state(false);
	let createDialogMode = $state<'file' | 'folder'>('file');
	let renameDialogOpen = $state(false);
	let deleteDialogOpen = $state(false);

	function handleClick() {
		if (isFolder) {
			fsState.actions.toggleExpand(id);
		} else {
			fsState.actions.selectFile(id);
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handleClick();
		}
	}

	function selectAndOpenCreate(mode: 'file' | 'folder') {
		fsState.actions.selectFile(id);
		createDialogMode = mode;
		createDialogOpen = true;
	}

	function selectAndOpenRename() {
		fsState.actions.selectFile(id);
		renameDialogOpen = true;
	}

	function selectAndOpenDelete() {
		fsState.actions.selectFile(id);
		deleteDialogOpen = true;
	}
</script>

{#if row}
	<ContextMenu.Root>
		<ContextMenu.Trigger>
			{#snippet child({ props })}
				{#if isFolder}
					<div {...props}>
						<Collapsible.Root open={isExpanded}>
							<Collapsible.Trigger>
								{#snippet child({ props: collapsibleProps })}
									<button
										{...collapsibleProps}
										class="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-sm hover:bg-accent {isSelected
											? 'bg-accent text-accent-foreground'
											: ''}"
										style="padding-left: {depth * 12 + 8}px"
										onclick={handleClick}
										onkeydown={handleKeydown}
										role="treeitem"
										aria-expanded={isExpanded}
									>
										<ChevronRight
											class="h-4 w-4 shrink-0 transition-transform {isExpanded
												? 'rotate-90'
												: ''}"
										/>
										{#if isExpanded}
											<FolderOpen class="h-4 w-4 shrink-0 text-muted-foreground" />
										{:else}
											<Folder class="h-4 w-4 shrink-0 text-muted-foreground" />
										{/if}
										<span class="truncate">{row.name}</span>
									</button>
								{/snippet}
							</Collapsible.Trigger>
							<Collapsible.Content>
								{#each children as childId (childId)}
									<TreeNode id={childId} depth={depth + 1} />
								{/each}
							</Collapsible.Content>
						</Collapsible.Root>
					</div>
				{:else}
					<button
						{...props}
						class="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-sm hover:bg-accent {isSelected
							? 'bg-accent text-accent-foreground'
							: ''}"
						style="padding-left: {depth * 12 + 8 + 20}px"
						onclick={handleClick}
						onkeydown={handleKeydown}
						role="treeitem"
					>
						<FileIcon class="h-4 w-4 shrink-0 text-muted-foreground" />
						<span class="truncate">{row.name}</span>
					</button>
				{/if}
			{/snippet}
		</ContextMenu.Trigger>
		<ContextMenu.Content>
			{#if isFolder}
				<ContextMenu.Item onclick={() => selectAndOpenCreate('file')}>
					New File
				</ContextMenu.Item>
				<ContextMenu.Item onclick={() => selectAndOpenCreate('folder')}>
					New Folder
				</ContextMenu.Item>
				<ContextMenu.Separator />
			{/if}
			<ContextMenu.Item onclick={selectAndOpenRename}>Rename</ContextMenu.Item>
			<ContextMenu.Item class="text-destructive" onclick={selectAndOpenDelete}>
				Delete
			</ContextMenu.Item>
		</ContextMenu.Content>
	</ContextMenu.Root>

	<CreateDialog bind:open={createDialogOpen} mode={createDialogMode} />
	<RenameDialog bind:open={renameDialogOpen} />
	<DeleteConfirmation bind:open={deleteDialogOpen} />
{/if}
