<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { fsState } from '$lib/state/fs-state.svelte';
	import ContentEditor from './ContentEditor.svelte';
	import PathBreadcrumb from './PathBreadcrumb.svelte';
	import TabBar from './TabBar.svelte';
</script>

<div class="flex h-full flex-col">
	<TabBar />

	{#if fsState.activeFileId && fsState.selectedNode}
		<div class="flex items-center border-b px-4 py-2"><PathBreadcrumb /></div>

		{#if fsState.selectedNode.type === 'folder'}
			<Empty.Root class="flex-1 border-0">
				<Empty.Header>
					<Empty.Title>Folder selected</Empty.Title>
					<Empty.Description>Select a file to view its contents</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else}
			<div class="flex-1 overflow-hidden">
				{#key fsState.activeFileId}
					<ContentEditor fileId={fsState.activeFileId} />
				{/key}
			</div>
		{/if}
	{:else}
		<Empty.Root class="h-full border-0">
			<Empty.Header>
				<Empty.Title>No file selected</Empty.Title>
				<Empty.Description>Click a file in the tree to view its contents</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{/if}
</div>
