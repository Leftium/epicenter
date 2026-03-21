<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import { fsState } from '$lib/state/fs-state.svelte';
	import ContentEditor from './ContentEditor.svelte';
	import PathBreadcrumb from './PathBreadcrumb.svelte';
	import SkillMetadataForm from './SkillMetadataForm.svelte';
	import TabBar from './TabBar.svelte';

	const isSkillMd = $derived(fsState.selectedNode?.name === 'SKILL.md');
</script>

<div class="flex h-full flex-col">
	<TabBar />
	{#if fsState.activeFileId && fsState.selectedNode}
		<div class="flex items-center border-b px-4 py-2"><PathBreadcrumb /></div>
		{#if fsState.selectedNode.type === 'folder'}
			<Empty.Root class="flex-1 border-0">
				<Empty.Header>
					<Empty.Title>Folder selected</Empty.Title>
					<Empty.Description
						>Select a file to view its contents</Empty.Description
					>
				</Empty.Header>
			</Empty.Root>
		{:else if isSkillMd}
			<ScrollArea class="flex-1">
				{#key fsState.activeFileId}
					<SkillMetadataForm fileId={fsState.activeFileId} />
				{/key}
				<div class="h-[50vh] min-h-64">
					{#key fsState.activeFileId}
						<ContentEditor fileId={fsState.activeFileId} />
					{/key}
				</div>
			</ScrollArea>
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
				<Empty.Description
					>Select a skill from the tree to edit its contents</Empty.Description
				>
			</Empty.Header>
		</Empty.Root>
	{/if}
</div>
