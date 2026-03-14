<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import * as Tabs from '@epicenter/ui/tabs';
	import { X } from 'lucide-svelte';
	import { fsState } from '$lib/fs/fs-state.svelte';

	const hasOpenFiles = $derived(fsState.openFileIds.length > 0);

	function handleValueChange(value: string) {
		fsState.actions.selectFile(value as FileId);
	}

	/**
	 * Close a tab, stopping propagation so the tab doesn't also get selected.
	 */
	function handleClose(e: MouseEvent, id: FileId) {
		e.stopPropagation();
		e.preventDefault();
		fsState.actions.closeFile(id);
	}

	/**
	 * Middle-click to close a tab.
	 */
	function handleAuxClick(e: MouseEvent, id: FileId) {
		if (e.button === 1) {
			e.preventDefault();
			fsState.actions.closeFile(id);
		}
	}
</script>

{#if hasOpenFiles}
	<Tabs.Root
		value={fsState.activeFileId ?? ''}
		onValueChange={handleValueChange}
		class="w-full"
	>
		<Tabs.List
			class="h-9 w-full justify-start gap-0 overflow-x-auto rounded-none border-b bg-transparent p-0"
		>
			{#each fsState.openFileIds as fileId (fileId)}
				{@const row = fsState.getRow(fileId)}
				{#if row}
					<Tabs.Trigger
						value={fileId}
						class="relative shrink-0 rounded-none border-b-2 border-transparent px-3 py-1.5 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
						onauxclick={(e) => handleAuxClick(e, fileId)}
					>
						<span class="mr-4">{row.name}</span>
						<button
							type="button"
							class="absolute right-1 top-1/2 -translate-y-1/2 rounded-sm p-0.5 opacity-50 hover:opacity-100 hover:bg-accent"
							onclick={(e) => handleClose(e, fileId)}
							aria-label="Close {row.name}"
						>
							<X class="h-3 w-3" />
						</button>
					</Tabs.Trigger>
				{/if}
			{/each}
		</Tabs.List>
	</Tabs.Root>
{/if}
