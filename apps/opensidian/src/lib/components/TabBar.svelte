<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import * as Tabs from '@epicenter/ui/tabs';
	import XIcon from '@lucide/svelte/icons/x';
	import { fsState } from '$lib/fs/fs-state.svelte';

	const hasOpenFiles = $derived(fsState.openFileIds.length > 0);

</script>

{#if hasOpenFiles}
	<Tabs.Root
		value={fsState.activeFileId ?? ''}
		onValueChange={(value) => fsState.selectFile(value as FileId)}
		class="w-full"
	>
		<Tabs.List
			class="w-full justify-start overflow-x-auto rounded-none border-b bg-transparent p-0"
		>
			{#each fsState.openFileIds as fileId (fileId)}
				{@const row = fsState.getRow(fileId)}
				{#if row}
					<Tabs.Trigger
						value={fileId}
						class="relative flex-none rounded-none border-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none"
					onauxclick={(e) => { if (e.button === 1) { e.preventDefault(); fsState.closeFile(fileId); } }}
					>
						<span class="mr-4">{row.name}</span>
						<button
							type="button"
							class="absolute right-1 top-1/2 -translate-y-1/2 rounded-sm p-0.5 opacity-50 hover:opacity-100 hover:bg-accent"
					onclick={(e) => { e.stopPropagation(); e.preventDefault(); fsState.closeFile(fileId); }}
							aria-label="Close {row.name}"
						>
							<XIcon class="h-3 w-3" />
						</button>
					</Tabs.Trigger>
				{/if}
			{/each}
		</Tabs.List>
	</Tabs.Root>
{/if}
