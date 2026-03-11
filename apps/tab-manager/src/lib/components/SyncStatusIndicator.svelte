<script module lang="ts">
	/**
	 * Reactive sync status state for the side panel.
	 *
	 * Reads the WebSocket sync provider's connection status and exposes it as
	 * a Svelte 5 `$state` value. The provider fires `onStatusChange` on every
	 * transition (`offline` -> `connecting` -> `connected`), and this module
	 * converts those callbacks into a reactive value the UI can bind to.
	 *
	 * Uses the same factory-function + singleton pattern as
	 * {@link savedTabState} — a `$state` value updated by provider callbacks,
	 * no polling, no derived stores.
	 */

	import type { SyncStatus } from '@epicenter/sync-client';
	import { workspaceClient } from '$lib/workspace';

	function createSyncStatus() {
		let current = $state<SyncStatus>(
			workspaceClient.extensions.sync.provider.status,
		);

		workspaceClient.extensions.sync.provider.onStatusChange((status) => {
			current = status;
		});

		return {
			/** Current sync connection status: `'offline'` | `'connecting'` | `'connected'`. */
			get current() {
				return current;
			},
		};
	}

	const syncStatus = createSyncStatus();
</script>

<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import Cloud from '@lucide/svelte/icons/cloud';
	import CloudOff from '@lucide/svelte/icons/cloud-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';

	const tooltip = $derived(
		syncStatus.current === 'connected'
			? 'Connected'
			: syncStatus.current === 'connecting'
				? 'Connecting…'
				: 'Offline',
	);
</script>

<Button {tooltip} variant="ghost" size="icon-sm">
	{#if syncStatus.current === 'connected'}
		<Cloud class="size-4" />
	{:else if syncStatus.current === 'connecting'}
		<LoaderCircle class="size-4 animate-spin" />
	{:else}
		<CloudOff class="size-4 text-destructive" />
	{/if}
</Button>
