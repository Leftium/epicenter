<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import SearchXIcon from '@lucide/svelte/icons/search-x';
	import { page } from '$app/state';

	const workspaceId = $derived(page.params.id);
	const settingKey = $derived(page.params.key);
</script>

<!--
	Settings page: Simplified for Static API.

	The Dynamic API stored KV schemas as runtime-introspectable Field objects.
	The Static API defines KV schemas in code via arktype types, so there's no
	runtime KV schema metadata to display. Current templates don't define KV stores.

	This page now shows a "not found" state. When KV support is needed,
	this can be extended to display KV values from `data.client.kv`.
-->
<div class="space-y-6">
	<Empty.Root>
		<Empty.Header>
			<Empty.Media variant="icon"> <SearchXIcon /> </Empty.Media>
			<Empty.Title>Setting not found</Empty.Title>
			<Empty.Description>
				The setting "{settingKey}" does not exist in this workspace.
			</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<Button variant="outline" href="/workspaces/{workspaceId}">
				Back to workspace
			</Button>
		</Empty.Content>
	</Empty.Root>
</div>
