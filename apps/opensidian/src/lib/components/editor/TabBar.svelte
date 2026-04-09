<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import { Button } from '@epicenter/ui/button';
	import * as Tabs from '@epicenter/ui/tabs';
	import XIcon from '@lucide/svelte/icons/x';
	import { getStars, GitHubButton } from '@epicenter/ui/github-button';
	import { fsState } from '$lib/state/fs-state.svelte';
	import SyncStatusIndicator from '$lib/components/SyncStatusIndicator.svelte';

</script>

<div class="flex items-center border-b">
	{#if fsState.hasOpenFiles}
		<Tabs.Root
			value={fsState.activeFileId ?? ''}
			onValueChange={(value) => fsState.selectFile(value as FileId)}
			class="flex-1 min-w-0"
		>
			<Tabs.List
				class="w-full justify-start overflow-x-auto rounded-none border-0 bg-transparent p-0"
			>
				{#each fsState.openFileIds as fileId (fileId)}
				{@const row = fsState.getFile(fileId)}
					{#if row}
						<Tabs.Trigger
							value={fileId}
							class="relative flex-none rounded-none border-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none"
							onauxclick={(e) => { if (e.button === 1) { e.preventDefault(); fsState.closeFile(fileId); } }}
						>
							<span class="mr-4">{row.name}</span>
							<Button
								variant="ghost"
								size="icon-xs"
								class="absolute right-1 top-1/2 -translate-y-1/2 opacity-50 hover:opacity-100"
							onclick={(e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); fsState.closeFile(fileId); }}
								aria-label="Close {row.name}"
							>
								<XIcon aria-hidden="true" class="size-3" />
							</Button>
						</Tabs.Trigger>
					{/if}
				{/each}
			</Tabs.List>
		</Tabs.Root>
	{/if}
	<div class="ml-auto flex shrink-0 items-center gap-1 px-2">
		<GitHubButton
			repo={{ owner: 'EpicenterHQ', repo: 'epicenter' }}
			path="/tree/main/apps/opensidian"
			stars={getStars({ owner: 'EpicenterHQ', repo: 'epicenter', fallback: 500 })}
			variant="ghost"
			size="sm"
		/>
		<SyncStatusIndicator />
	</div>
</div>
