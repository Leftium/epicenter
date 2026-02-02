<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Popover from '@epicenter/ui/popover';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import { cn } from '@epicenter/ui/utils';
	import { createTableDialog } from '$lib/components/CreateTableDialog.svelte';
	import { createSettingDialog } from '$lib/components/CreateSettingDialog.svelte';
	import { confirmationDialog } from '$lib/components/ConfirmationDialog.svelte';
	import { rpc } from '$lib/query';
	import { createQuery, createMutation } from '@tanstack/svelte-query';
	import TableIcon from '@lucide/svelte/icons/table-2';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import LayoutGridIcon from '@lucide/svelte/icons/layout-grid';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

	const workspaceId = $derived(page.params.id);

	const workspaces = createQuery(() => rpc.workspaces.listWorkspaces.options);
	const workspace = createQuery(() => ({
		...rpc.workspaces.getWorkspace(workspaceId ?? '').options,
		enabled: !!workspaceId,
	}));

	const tableEntries = $derived(
		workspace.data
			? Object.entries(workspace.data.tables).map(([key, table]) => ({
					key,
					name: table.name,
					icon: table.icon,
					description: table.description,
				}))
			: [],
	);
	const settings = $derived(
		workspace.data ? Object.keys(workspace.data.kv) : [],
	);

	const addTableMutation = createMutation(
		() => rpc.workspaces.addTable.options,
	);
	const addKvEntryMutation = createMutation(
		() => rpc.workspaces.addKvEntry.options,
	);
	const openDirectoryMutation = createMutation(
		() => rpc.workspaces.openWorkspacesDirectory.options,
	);
	const removeTableMutation = createMutation(
		() => rpc.workspaces.removeTable.options,
	);
	const deleteWorkspaceMutation = createMutation(
		() => rpc.workspaces.deleteWorkspace.options,
	);
</script>

<Sidebar.Root>
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Sidebar.MenuButton {...props} size="lg">
								<div
									class="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 items-center justify-center rounded-lg"
								>
									<FolderIcon class="size-4" />
								</div>
								<div class="grid flex-1 text-left text-sm leading-tight">
									<span class="truncate font-semibold">
										{workspace.data?.name ?? 'Loading...'}
									</span>
									<span class="truncate text-xs text-muted-foreground">
										{workspaceId}
									</span>
								</div>
								<ChevronDownIcon class="ml-auto opacity-50" />
							</Sidebar.MenuButton>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content
						class="w-64 rounded-lg"
						align="start"
						side="bottom"
						sideOffset={4}
					>
						<DropdownMenu.Label class="text-muted-foreground text-xs">
							Workspaces
						</DropdownMenu.Label>
						{#if workspaces.data}
							{#each workspaces.data as ws (ws.id)}
								<div class="group relative flex items-center">
									<DropdownMenu.Item
										onclick={() => goto(`/workspaces/${ws.id}`)}
										class={cn(
											'flex-1 gap-2 p-2',
											ws.id === workspaceId &&
												'bg-accent text-accent-foreground',
										)}
									>
										<div
											class="flex size-6 items-center justify-center rounded-sm border"
										>
											<FolderIcon class="size-4 shrink-0" />
										</div>
										{ws.name}
									</DropdownMenu.Item>
									<Popover.Root>
										<Popover.Trigger
											class={cn(
												buttonVariants({ variant: 'ghost', size: 'icon' }),
												'absolute right-1 top-1/2 size-6 -translate-y-1/2',
											)}
										>
											<EllipsisIcon class="size-4" />
										</Popover.Trigger>
										<Popover.Content
											class="min-w-32 p-1"
											align="start"
											side="right"
										>
											<Button
												variant="ghost"
												size="sm"
												class="w-full justify-start gap-2 text-destructive hover:text-destructive hover:bg-destructive/10"
												onclick={() => {
													confirmationDialog.open({
														title: 'Delete Workspace',
														description: `Are you sure you want to delete "${ws.name}"? This will permanently delete all tables and settings in this workspace.`,
														confirm: { text: 'Delete', variant: 'destructive' },
														onConfirm: async () => {
															await deleteWorkspaceMutation.mutateAsync(ws.id);
															if (workspaceId === ws.id) {
																await goto('/');
															}
														},
													});
												}}
											>
												<TrashIcon class="size-4" />
												Delete
											</Button>
										</Popover.Content>
									</Popover.Root>
								</div>
							{/each}
						{/if}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton>
							{#snippet child({ props })}
								<a href="/" {...props}>
									<LayoutGridIcon />
									<span>All Workspaces</span>
								</a>
							{/snippet}
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>

		<Collapsible.Root open>
			<Sidebar.Group>
				<Sidebar.GroupLabel>
					{#snippet child({ props })}
						<Collapsible.Trigger {...props}>Tables</Collapsible.Trigger>
					{/snippet}
				</Sidebar.GroupLabel>
				<Sidebar.GroupAction
					title="Add Table"
					onclick={() => {
						if (!workspaceId) return;
						createTableDialog.open({
							onConfirm: async ({ name, id, icon, description }) => {
								await addTableMutation.mutateAsync({
									workspaceId,
									name,
									id,
									icon,
									description,
								});
								await invalidateAll();
							},
						});
					}}
				>
					<PlusIcon />
					<span class="sr-only">Add Table</span>
				</Sidebar.GroupAction>
				<Collapsible.Content>
					<Sidebar.GroupContent>
						<Sidebar.Menu>
							{#each tableEntries as table (table.key)}
								<Sidebar.MenuItem>
									<Sidebar.MenuButton>
										{#snippet child({ props })}
											<a
												href="/workspaces/{workspaceId}/tables/{table.key}"
												{...props}
											>
												{#if table.icon?.type === 'emoji'}
													<span class="text-base leading-none"
														>{table.icon.value}</span
													>
												{:else if table.icon?.type === 'external'}
													<img
														src={table.icon.url}
														alt=""
														class="size-4 object-contain"
													/>
												{:else}
													<TableIcon />
												{/if}
												<span>{table.name}</span>
											</a>
										{/snippet}
									</Sidebar.MenuButton>
									<Sidebar.MenuAction
										showOnHover
										title="Delete Table"
										onclick={() => {
											if (!workspaceId) return;
											confirmationDialog.open({
												title: 'Delete Table',
												description: `Are you sure you want to delete "${table.name}"? This action cannot be undone.`,
												confirm: { text: 'Delete', variant: 'destructive' },
												onConfirm: async () => {
													await removeTableMutation.mutateAsync({
														workspaceId,
														tableName: table.key,
													});
													await invalidateAll();
													await goto(`/workspaces/${workspaceId}`);
												},
											});
										}}
									>
										<TrashIcon class="size-4" />
										<span class="sr-only">Delete Table</span>
									</Sidebar.MenuAction>
								</Sidebar.MenuItem>
							{:else}
								<Sidebar.MenuItem>
									<span class="text-muted-foreground px-2 py-1 text-xs">
										No tables yet
									</span>
								</Sidebar.MenuItem>
							{/each}
						</Sidebar.Menu>
					</Sidebar.GroupContent>
				</Collapsible.Content>
			</Sidebar.Group>
		</Collapsible.Root>

		<Collapsible.Root open>
			<Sidebar.Group>
				<Sidebar.GroupLabel>
					{#snippet child({ props })}
						<Collapsible.Trigger {...props}>Settings</Collapsible.Trigger>
					{/snippet}
				</Sidebar.GroupLabel>
				<Sidebar.GroupAction
					title="Add Setting"
					onclick={() => {
						if (!workspaceId) return;
						createSettingDialog.open({
							onConfirm: async ({ name, key }) => {
								await addKvEntryMutation.mutateAsync({
									workspaceId,
									name,
									key,
								});
							},
						});
					}}
				>
					<PlusIcon />
					<span class="sr-only">Add Setting</span>
				</Sidebar.GroupAction>
				<Collapsible.Content>
					<Sidebar.GroupContent>
						<Sidebar.Menu>
							{#each settings as settingKey (settingKey)}
								<Sidebar.MenuItem>
									<Sidebar.MenuButton>
										{#snippet child({ props })}
											<a
												href="/workspaces/{workspaceId}/settings/{settingKey}"
												{...props}
											>
												<SettingsIcon />
												<span>{settingKey}</span>
											</a>
										{/snippet}
									</Sidebar.MenuButton>
								</Sidebar.MenuItem>
							{:else}
								<Sidebar.MenuItem>
									<span class="text-muted-foreground px-2 py-1 text-xs">
										No settings yet
									</span>
								</Sidebar.MenuItem>
							{/each}
						</Sidebar.Menu>
					</Sidebar.GroupContent>
				</Collapsible.Content>
			</Sidebar.Group>
		</Collapsible.Root>
	</Sidebar.Content>

	<Sidebar.Footer>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton
					onclick={() => openDirectoryMutation.mutate(undefined)}
					disabled={openDirectoryMutation.isPending}
				>
					<FolderOpenIcon />
					<span>Open Data Folder</span>
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Footer>

	<Sidebar.Rail />
</Sidebar.Root>
