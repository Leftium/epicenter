<script lang="ts">
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { foldersState, notesState, viewState } from '$lib/state';
	import type { Folder, FolderId } from '$lib/workspace';

	let editingFolderId = $state<FolderId | null>(null);
	let editingName = $state('');
	let deletingFolderId = $state<FolderId | null>(null);

	function startRename(folder: Folder) {
		editingFolderId = folder.id;
		editingName = folder.name;
	}

	function commitRename() {
		if (editingFolderId && editingName.trim()) {
			foldersState.renameFolder(editingFolderId, editingName.trim());
		}
		editingFolderId = null;
		editingName = '';
	}

	function cancelRename() {
		editingFolderId = null;
		editingName = '';
	}

	function confirmDelete() {
		if (deletingFolderId) {
			foldersState.deleteFolder(deletingFolderId);
		}
		deletingFolderId = null;
	}
</script>

<Sidebar.Root>
	<Sidebar.Header>
		<div class="flex items-center justify-between px-2 py-1">
			<span class="text-sm font-semibold">Honeycrisp</span>
			<Sidebar.Trigger />
		</div>
		<div class="px-2 pb-1">
			<Sidebar.Input
				placeholder="Search notes…"
				value={viewState.searchQuery}
				oninput={(e) => viewState.setSearchQuery(e.currentTarget.value)}
			/>
		</div>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							isActive={viewState.selectedFolderId === null && !viewState.isRecentlyDeletedView}
							onclick={() => viewState.selectFolder(null)}
						>
							<FileTextIcon class="size-4" />
							<span>All Notes</span>
							<span class="ml-auto text-xs text-muted-foreground">
								{notesState.notes.length}
							</span>
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							isActive={viewState.isRecentlyDeletedView && viewState.selectedFolderId === null}
							onclick={() => viewState.selectRecentlyDeleted()}
						>
							<TrashIcon class="size-4" />
							<span>Recently Deleted</span>
							{#if notesState.deletedNotes.length > 0}
								<span class="ml-auto text-xs text-muted-foreground">
									{notesState.deletedNotes.length}
								</span>
							{/if}
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>

		<Collapsible.Root open>
			<Sidebar.Group>
				<Collapsible.Trigger>
					<Sidebar.GroupLabel>Folders</Sidebar.GroupLabel>
				</Collapsible.Trigger>
				<Sidebar.GroupAction
					title="New Folder"
					onclick={() => foldersState.createFolder()}
				>
					<PlusIcon />
					<span class="sr-only">New Folder</span>
				</Sidebar.GroupAction>
				<Collapsible.Content>
					<Sidebar.GroupContent>
						<Sidebar.Menu>
							{#each foldersState.folders as folder (folder.id)}
								<Sidebar.MenuItem>
									{#if editingFolderId === folder.id}
										<div class="flex items-center gap-2 px-2 py-1">
											<!-- svelte-ignore a11y_autofocus -->
											<input
												class="flex-1 rounded border bg-background px-1 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
												bind:value={editingName}
												onkeydown={(e) => {
													if (e.key === 'Enter') commitRename();
													if (e.key === 'Escape') cancelRename();
												}}
												onblur={commitRename}
												autofocus
											>
										</div>
									{:else}
										<Sidebar.MenuButton
											isActive={viewState.selectedFolderId === folder.id}
											onclick={() => viewState.selectFolder(folder.id)}
										>
											{#if folder.icon}
												<span class="text-base leading-none"
													>{folder.icon}</span
												>
											{:else}
												<FolderIcon class="size-4" />
											{/if}
											<span>{folder.name}</span>
											<span class="ml-auto text-xs text-muted-foreground">
												{notesState.noteCounts[folder.id] ?? 0}
											</span>
										</Sidebar.MenuButton>
										<DropdownMenu.Root>
											<DropdownMenu.Trigger>
												{#snippet child({ props })}
													<Sidebar.MenuAction showOnHover {...props}>
														<EllipsisIcon class="size-4" />
														<span class="sr-only">Folder actions</span>
													</Sidebar.MenuAction>
												{/snippet}
											</DropdownMenu.Trigger>
											<DropdownMenu.Content
												align="start"
												side="right"
												class="w-40"
											>
												<DropdownMenu.Item onclick={() => startRename(folder)}>
													<PencilIcon class="mr-2 size-4" />
													Rename
												</DropdownMenu.Item>
												<DropdownMenu.Separator />
												<DropdownMenu.Item
													class="text-destructive focus:text-destructive"
													onclick={() => (deletingFolderId = folder.id)}
												>
													<TrashIcon class="mr-2 size-4" />
													Delete
												</DropdownMenu.Item>
											</DropdownMenu.Content>
										</DropdownMenu.Root>
									{/if}
								</Sidebar.MenuItem>
							{:else}
								<Sidebar.MenuItem>
									<span class="text-muted-foreground px-2 py-1 text-xs">
										No folders yet
									</span>
								</Sidebar.MenuItem>
							{/each}
						</Sidebar.Menu>
					</Sidebar.GroupContent>
				</Collapsible.Content>
			</Sidebar.Group>
		</Collapsible.Root>
	</Sidebar.Content>

	<Sidebar.Rail />
</Sidebar.Root>

<AlertDialog.Root
	open={!!deletingFolderId}
	onOpenChange={(open) => { if (!open) deletingFolderId = null; }}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete Folder?</AlertDialog.Title>
			<AlertDialog.Description>
				Notes in this folder will be moved to All Notes.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel onclick={() => (deletingFolderId = null)}
				>Cancel</AlertDialog.Cancel
			>
			<AlertDialog.Action
				class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
				onclick={confirmDelete}
			>
				Delete
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
