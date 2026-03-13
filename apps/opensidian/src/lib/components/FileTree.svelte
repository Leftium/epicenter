<script lang="ts">
	import { fsState } from '$lib/fs/fs-state.svelte';
	import * as Empty from '@epicenter/ui/empty';
	import TreeNode from './TreeNode.svelte';
</script>

{#if fsState.rootChildIds.length === 0}
	<Empty.Root class="border-0">
		<Empty.Header>
			<Empty.Title>No files yet</Empty.Title>
			<Empty.Description>Use the toolbar to create files and folders</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<div class="flex flex-col gap-0.5" role="tree">
		{#each fsState.rootChildIds as childId (childId)}
			<TreeNode id={childId} depth={0} />
		{/each}
	</div>
{/if}
