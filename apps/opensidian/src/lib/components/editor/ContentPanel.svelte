<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import { getSignedInSession } from '$lib/session.svelte';
	import ContentEditor from './ContentEditor.svelte';
	import PathBreadcrumb from './PathBreadcrumb.svelte';
	import TabBar from './TabBar.svelte';

	const signedIn = getSignedInSession();
</script>

<div class="flex h-full flex-col">
	<TabBar />

	{#if signedIn.state.files.activeFileId && signedIn.state.files.selectedNode}
		<div class="flex items-center border-b px-4 py-2"><PathBreadcrumb /></div>

		{#if signedIn.state.files.selectedNode.type === 'folder'}
			<Empty.Root class="flex-1 border-0">
				<Empty.Header>
					<Empty.Title>Folder selected</Empty.Title>
					<Empty.Description
						>Select a file to view its contents</Empty.Description
					>
				</Empty.Header>
			</Empty.Root>
		{:else}
			<div class="flex-1 overflow-hidden">
				{#key signedIn.state.files.activeFileId}
					<ContentEditor fileId={signedIn.state.files.activeFileId} />
				{/key}
			</div>
		{/if}
	{:else}
		<Empty.Root class="h-full border-0">
			<Empty.Header>
				<Empty.Title>No file selected</Empty.Title>
				<Empty.Description
					>Click a file in the tree, or use the terminal below</Empty.Description
				>
			</Empty.Header>
			{#if signedIn.state.files.rootChildIds.length === 0}
				<Button
					variant="outline"
					size="sm"
					onclick={() => signedIn.state.sampleData.load()}
					disabled={signedIn.state.sampleData.seeding}
				>
					{#if signedIn.state.sampleData.seeding}
						<Spinner class="size-3.5" />
					{:else}
						Load Sample Data
					{/if}
				</Button>
			{/if}
		</Empty.Root>
	{/if}
</div>
