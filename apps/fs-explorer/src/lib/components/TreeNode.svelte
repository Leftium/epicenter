<script lang="ts">
	import * as Collapsible from '@epicenter/ui/collapsible';
	import { fsState } from '$lib/fs/fs-state.svelte';
	import type { FileId } from '@epicenter/filesystem';

	type Props = {
		id: FileId;
		depth: number;
	};

	let { id, depth }: Props = $props();

	const row = $derived(fsState.getRow(id));
	const isFolder = $derived(row?.type === 'folder');
	const isExpanded = $derived(fsState.expandedIds.has(id));
	const isSelected = $derived(fsState.activeFileId === id);
	const children = $derived(isFolder ? fsState.getChildIds(id) : []);

	function handleClick() {
		if (isFolder) {
			fsState.actions.toggleExpand(id);
		} else {
			fsState.actions.selectFile(id);
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handleClick();
		}
	}
</script>

{#if row}
	{#if isFolder}
		<Collapsible.Root open={isExpanded}>
			<Collapsible.Trigger asChild>
				{#snippet child({ props })}
					<button
						{...props}
						class="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-sm hover:bg-accent {isSelected
							? 'bg-accent text-accent-foreground'
							: ''}"
						style="padding-left: {depth * 12 + 8}px"
						onclick={handleClick}
						onkeydown={handleKeydown}
						role="treeitem"
						aria-expanded={isExpanded}
					>
						<svg
							class="h-4 w-4 shrink-0 transition-transform {isExpanded
								? 'rotate-90'
								: ''}"
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="m9 18 6-6-6-6" />
						</svg>
						<svg
							class="h-4 w-4 shrink-0 text-muted-foreground"
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							{#if isExpanded}
								<path
									d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
								/>
							{:else}
								<path
									d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
								/>
							{/if}
						</svg>
						<span class="truncate">{row.name}</span>
					</button>
				{/snippet}
			</Collapsible.Trigger>
			<Collapsible.Content>
				{#each children as childId (childId)}
					<svelte:self id={childId} depth={depth + 1} />
				{/each}
			</Collapsible.Content>
		</Collapsible.Root>
	{:else}
		<button
			class="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-sm hover:bg-accent {isSelected
				? 'bg-accent text-accent-foreground'
				: ''}"
			style="padding-left: {depth * 12 + 8 + 20}px"
			onclick={handleClick}
			onkeydown={handleKeydown}
			role="treeitem"
		>
			<svg
				class="h-4 w-4 shrink-0 text-muted-foreground"
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
				<path d="M14 2v4a2 2 0 0 0 2 2h4" />
			</svg>
			<span class="truncate">{row.name}</span>
		</button>
	{/if}
{/if}
