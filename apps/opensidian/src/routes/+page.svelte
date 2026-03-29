<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import AppShell from '$lib/components/AppShell.svelte';
	import { workspace } from '$lib/workspace.svelte';
</script>

{#await workspace.whenReady}
	<div class="flex h-screen items-center justify-center">
		<div class="flex flex-col items-center gap-3">
			<Spinner class="size-5 text-muted-foreground" />
			<p class="text-sm text-muted-foreground">Loading workspace…</p>
		</div>
	</div>
{:then}
	<AppShell />
{:catch}
	<div class="flex h-screen items-center justify-center">
		<Empty.Root>
			<Empty.Media>
				<TriangleAlertIcon class="size-8 text-muted-foreground" />
			</Empty.Media>
			<Empty.Title>Failed to load workspace</Empty.Title>
			<Empty.Description>
				Something went wrong initializing the workspace. Try refreshing the
				page.
			</Empty.Description>
		</Empty.Root>
	</div>
{/await}
