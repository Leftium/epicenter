<!--
	Render gate that blocks children until `pending` resolves.

	Composition: defaults the loading state to <Loading> (the same shell
	used by pre-auth layouts) so the moment children mount is the only
	visible transition. The error state defaults to a workspace-flavored
	Empty.Root with Reload + (optional) Sign out actions.

	Both branches accept snippet overrides for apps that need different chrome.

	@example
	```svelte
	<script lang="ts">
		import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
		import { auth, fuji } from '$lib/fuji/client';
	</script>

	<WorkspaceGate pending={fuji.idb.whenLoaded} onSignOut={() => auth.signOut()}>
		{@render children?.()}
	</WorkspaceGate>
	```
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { Snippet } from 'svelte';

	let {
		pending,
		children,
		loading,
		error,
		onSignOut,
	}: {
		/** Promise the gate awaits before rendering children. */
		pending: Promise<unknown>;
		/** Children rendered after `pending` resolves. */
		children: Snippet;
		/** Override for the loading branch. Defaults to <Loading>. */
		loading?: Snippet;
		/** Override for the error branch. Receives the rejection reason. */
		error?: Snippet<[unknown]>;
		/**
		 * If provided, the default error branch shows a Sign out button that
		 * invokes this callback. Omit on apps that have no auth (or where the
		 * gate runs above auth).
		 */
		onSignOut?: () => void;
	} = $props();
</script>

{#await pending}
	{#if loading}
		{@render loading()}
	{:else}
		<Loading class="h-dvh" />
	{/if}
{:then _}
	{@render children()}
{:catch err}
	{#if error}
		{@render error(err)}
	{:else}
		<Empty.Root class="h-dvh flex-none border-0">
			<Empty.Media>
				<TriangleAlertIcon class="size-8 text-muted-foreground" />
			</Empty.Media>
			<Empty.Title>Failed to load workspace</Empty.Title>
			<Empty.Description>
				{err instanceof Error
					? err.message
					: 'The workspace could not be opened.'}
			</Empty.Description>
			<Empty.Content>
				<div class="flex items-center gap-2">
					<Button variant="outline" onclick={() => window.location.reload()}>
						Reload
					</Button>
					{#if onSignOut}
						<Button onclick={onSignOut}>Sign out</Button>
					{/if}
				</div>
			</Empty.Content>
		</Empty.Root>
	{/if}
{/await}
