<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import type { Folder, FolderId } from '$lib/workspace';

	let {
		folders,
		selectedFolderId,
		noteCounts,
		totalNoteCount,
		onSelectFolder,
		onCreateFolder,
	}: {
		folders: Folder[];
		selectedFolderId: FolderId | null;
		noteCounts: Record<string, number>;
		totalNoteCount: number;
		onSelectFolder: (folderId: FolderId | null) => void;
		onCreateFolder: () => void;
	} = $props();
</script>

<Sidebar.Root>
	<Sidebar.Header>
		<div class="flex items-center justify-between px-2 py-1">
			<span class="text-sm font-semibold">Honeycrisp</span>
		</div>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							isActive={selectedFolderId === null}
							onclick={() => onSelectFolder(null)}
						>
							<FileTextIcon class="size-4" />
							<span>All Notes</span>
							<span class="ml-auto text-xs text-muted-foreground">
								{totalNoteCount}
							</span>
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>

		<Sidebar.Group>
			<Sidebar.GroupLabel>Folders</Sidebar.GroupLabel>
			<Sidebar.GroupAction title="New Folder" onclick={onCreateFolder}>
				<PlusIcon />
				<span class="sr-only">New Folder</span>
			</Sidebar.GroupAction>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each folders as folder (folder.id)}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								isActive={selectedFolderId === folder.id}
								onclick={() => onSelectFolder(folder.id)}
							>
								{#if folder.icon}
									<span class="text-base leading-none">{folder.icon}</span>
								{:else}
									<FolderIcon class="size-4" />
								{/if}
								<span>{folder.name}</span>
								<span class="ml-auto text-xs text-muted-foreground">
									{noteCounts[folder.id] ?? 0}
								</span>
							</Sidebar.MenuButton>
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
		</Sidebar.Group>
	</Sidebar.Content>

	<Sidebar.Footer>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Button
					variant="ghost"
					size="sm"
					class="w-full justify-start gap-2"
					onclick={onCreateFolder}
				>
					<PlusIcon class="size-4" />
					<span>New Folder</span>
				</Button>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Footer>

	<Sidebar.Rail />
</Sidebar.Root>
