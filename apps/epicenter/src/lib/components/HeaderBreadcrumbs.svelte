<script lang="ts">
	import { page } from '$app/state';
	import { createQuery } from '@tanstack/svelte-query';
	import * as Breadcrumb from '@epicenter/ui/breadcrumb';
	import { rpc } from '$lib/query';

	const workspaceId = $derived(page.params.id);
	const tableId = $derived(page.params.tableId);
	const settingKey = $derived(page.params.key);

	const workspace = createQuery(() => ({
		...rpc.workspaces.getWorkspace(workspaceId ?? '').options,
		enabled: !!workspaceId,
	}));

	const workspaceName = $derived(workspace.data?.name ?? workspaceId);
	const tableName = $derived(() => {
		if (!tableId || !workspace.data?.tables) return tableId;
		const table = workspace.data.tables[tableId];
		if (!table) return tableId;
		return table.name;
	});
</script>

<Breadcrumb.Root>
	<Breadcrumb.List>
		<Breadcrumb.Item>
			{#if workspaceId}
				<Breadcrumb.Link href="/">Workspaces</Breadcrumb.Link>
			{:else}
				<Breadcrumb.Page>Workspaces</Breadcrumb.Page>
			{/if}
		</Breadcrumb.Item>

		{#if workspaceId}
			<Breadcrumb.Separator />
			<Breadcrumb.Item>
				{#if tableId || settingKey}
					<Breadcrumb.Link href="/workspaces/{workspaceId}">
						{workspaceName}
					</Breadcrumb.Link>
				{:else}
					<Breadcrumb.Page>{workspaceName}</Breadcrumb.Page>
				{/if}
			</Breadcrumb.Item>
		{/if}

		{#if tableId}
			<Breadcrumb.Separator />
			<Breadcrumb.Item>
				<Breadcrumb.Page>{tableName()}</Breadcrumb.Page>
			</Breadcrumb.Item>
		{/if}

		{#if settingKey}
			<Breadcrumb.Separator />
			<Breadcrumb.Item>
				<Breadcrumb.Page>{settingKey}</Breadcrumb.Page>
			</Breadcrumb.Item>
		{/if}
	</Breadcrumb.List>
</Breadcrumb.Root>
