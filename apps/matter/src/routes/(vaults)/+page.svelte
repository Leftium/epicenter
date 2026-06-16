<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import { openVaults } from '$lib/open-vaults.svelte';
</script>

<Empty.Root class="flex-1 border-0">
	<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
	<Empty.Title>Open a folder</Empty.Title>
	<Empty.Description>
		Choose one markdown folder to inspect its frontmatter. Matter reads a single folder as one
		table, so open a leaf folder (the one holding the .md files), not a parent that just contains
		other folders.
	</Empty.Description>
	<Empty.Content>
		<Button onclick={openVaults.open}>
			<FolderOpenIcon />
			Open folder
		</Button>
		<Button variant="link" size="sm" href="/demo/references" class="text-muted-foreground">
			Or see the row-level reference demo
		</Button>
	</Empty.Content>
</Empty.Root>
