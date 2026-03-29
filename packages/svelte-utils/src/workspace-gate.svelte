<!--
	Render gate that blocks children until a workspace `whenReady` promise resolves.

	Shows a centered spinner while loading and an error state if initialization
	fails. Both states are overridable via optional snippets.

	@example
	```svelte
	<script lang="ts">
		import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
		import workspace from '$lib/workspace';
	</script>

	<WorkspaceGate whenReady={workspace.whenReady}>
		<AppShell />
	</WorkspaceGate>
	```
-->
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { Snippet } from 'svelte';

	let {
		whenReady,
		children,
		loading,
		error,
	}: {
		/** Promise that resolves when the workspace is ready to read. */
		whenReady: Promise<unknown>;
		/** Content to render once the workspace is ready. */
		children: Snippet;
		/** Optional override for the loading state. Defaults to a centered spinner. */
		loading?: Snippet;
		/** Optional override for the error state. Defaults to an Empty with a warning icon. */
		error?: Snippet<[unknown]>;
	} = $props();
</script>

{#await whenReady}
	{#if loading}
		{@render loading()}
	{:else}
		<div class="flex min-h-screen items-center justify-center">
			<Spinner class="size-5 text-muted-foreground" />
		</div>
	{/if}
{:then}
	{@render children()}
{:catch err}
	{#if error}
		{@render error(err)}
	{:else}
		<div class="flex min-h-screen items-center justify-center">
			<Empty.Root class="border-none">
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
	{/if}
{/await}
