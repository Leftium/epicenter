<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import * as TreeView from '@epicenter/ui/tree-view';
	import { fsState } from '$lib/fs/fs-state.svelte';
	import FileTreeItem from './FileTreeItem.svelte';
</script>

{#if fsState.rootChildIds.length === 0}
	<Empty.Root class="border-0">
		<Empty.Header>
			<Empty.Title>No files yet</Empty.Title>
			<Empty.Description
				>Use the toolbar to create files and folders</Empty.Description
			>
		</Empty.Header>
	</Empty.Root>
{:else}
	<TreeView.Root class="gap-0.5" role="tree">
		{#each fsState.rootChildIds as childId (childId)}
			<FileTreeItem id={childId} />
		{/each}
	</TreeView.Root>
{/if}
