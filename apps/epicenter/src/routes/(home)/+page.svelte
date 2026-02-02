<script lang="ts">
	import { createQuery, createMutation } from '@tanstack/svelte-query';
	import { rpc } from '$lib/query';
	import { Button } from '@epicenter/ui/button';
	import * as Item from '@epicenter/ui/item';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import { createWorkspaceDialog } from '$lib/components/CreateWorkspaceDialog.svelte';
	import { editWorkspaceDialog } from '$lib/components/EditWorkspaceDialog.svelte';
	import { confirmationDialog } from '$lib/components/ConfirmationDialog.svelte';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import PlusIcon from '@lucide/svelte/icons/plus';

	const workspaces = createQuery(() => rpc.workspaces.listWorkspaces.options);
	const createWorkspace = createMutation(
		() => rpc.workspaces.createWorkspace.options,
	);
	const updateWorkspace = createMutation(
		() => rpc.workspaces.updateWorkspace.options,
	);
	const deleteWorkspace = createMutation(
		() => rpc.workspaces.deleteWorkspace.options,
	);
	const openDirectory = createMutation(
		() => rpc.workspaces.openWorkspacesDirectory.options,
	);
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold">All Workspaces</h1>
		<div class="flex gap-2">
			<Button
				variant="outline"
				onclick={() => openDirectory.mutate(undefined)}
				disabled={openDirectory.isPending}
			>
				<FolderOpenIcon class="mr-2 size-4" />
				Open Location
			</Button>
			<Button
				onclick={() =>
					createWorkspaceDialog.open({
						onConfirm: async ({ name, id, template }) => {
							await createWorkspace.mutateAsync({ name, id, template });
						},
					})}
				disabled={createWorkspace.isPending}
			>
				<PlusIcon class="mr-2 size-4" />
				{createWorkspace.isPending ? 'Creating...' : 'Create Workspace'}
			</Button>
		</div>
	</div>

	{#if workspaces.isPending}
		<Item.Group class="rounded-lg border">
			{#each { length: 3 } as _, i}
				<Item.Root>
					<Item.Media variant="icon">
						<Skeleton class="size-4" />
					</Item.Media>
					<Item.Content>
						<Skeleton class="h-4 w-32" />
						<Skeleton class="h-3 w-24" />
					</Item.Content>
				</Item.Root>
				{#if i < 2}
					<Item.Separator />
				{/if}
			{/each}
		</Item.Group>
	{:else if workspaces.error}
		<div
			class="rounded-lg border border-destructive/50 bg-destructive/10 p-8 text-center"
		>
			<p class="text-destructive">Error loading workspaces</p>
		</div>
	{:else if workspaces.data?.length === 0}
		<div class="rounded-lg border border-dashed p-8">
			<Empty.Root>
				<Empty.Header>
					<Empty.Media variant="icon">
						<FolderIcon />
					</Empty.Media>
					<Empty.Title>No workspaces yet</Empty.Title>
					<Empty.Description>
						Create your first workspace to get started.
					</Empty.Description>
				</Empty.Header>
				<Empty.Content>
					<Button
						onclick={() =>
							createWorkspaceDialog.open({
								onConfirm: async ({ name, id, template }) => {
									await createWorkspace.mutateAsync({ name, id, template });
								},
							})}
					>
						<PlusIcon class="mr-2 size-4" />
						Create Workspace
					</Button>
				</Empty.Content>
			</Empty.Root>
		</div>
	{:else}
		<Item.Group class="rounded-lg border">
			{#each workspaces.data ?? [] as workspace, i (workspace.id)}
				<Item.Root>
					{#snippet child({ props })}
						<a href="/workspaces/{workspace.id}" {...props}>
							<Item.Media variant="icon">
								<FolderIcon class="size-4" />
							</Item.Media>
							<Item.Content>
								<Item.Title>{workspace.name}</Item.Title>
								<Item.Description class="font-mono text-xs">
									{workspace.id}
								</Item.Description>
							</Item.Content>
							<Item.Actions>
								<DropdownMenu.Root>
									<DropdownMenu.Trigger
										onclick={(e: MouseEvent) => e.preventDefault()}
										class="rounded-md p-1.5 hover:bg-accent"
									>
										<EllipsisIcon class="size-4" />
										<span class="sr-only">Actions</span>
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="end">
										<DropdownMenu.Item
											onclick={(e: Event) => {
												e.preventDefault();
												editWorkspaceDialog.open({
													workspaceId: workspace.id,
													currentName: workspace.name,
													onConfirm: async ({ name }) => {
														await updateWorkspace.mutateAsync({
															workspaceId: workspace.id,
															name,
														});
													},
												});
											}}
										>
											<PencilIcon class="mr-2 size-4" />
											Edit
										</DropdownMenu.Item>
										<DropdownMenu.Separator />
										<DropdownMenu.Item
											class="text-destructive focus:text-destructive"
											onclick={(e: Event) => {
												e.preventDefault();
												confirmationDialog.open({
													title: 'Delete Workspace',
													description: `Are you sure you want to delete "${workspace.name}"? This will permanently delete all tables and settings in this workspace.`,
													confirm: { text: 'Delete', variant: 'destructive' },
													input: { confirmationText: workspace.id },
													onConfirm: async () => {
														await deleteWorkspace.mutateAsync(workspace.id);
													},
												});
											}}
										>
											<TrashIcon class="mr-2 size-4" />
											Delete
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</Item.Actions>
						</a>
					{/snippet}
				</Item.Root>
				{#if i < (workspaces.data?.length ?? 0) - 1}
					<Item.Separator />
				{/if}
			{/each}
		</Item.Group>
	{/if}
</div>
