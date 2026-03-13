<script lang="ts">
	import { fsState } from '$lib/fs/fs-state.svelte';
	import TreeNode from './TreeNode.svelte';
</script>

{#if fsState.rootChildIds.length === 0}
	<div
		class="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground"
	>
		<p>No files yet</p>
		<p class="text-xs">Use the toolbar to create files and folders</p>
	</div>
{:else}
	<div class="flex flex-col gap-0.5" role="tree">
		{#each fsState.rootChildIds as childId (childId)}
			<TreeNode id={childId} depth={0} />
		{/each}
	</div>
{/if}
