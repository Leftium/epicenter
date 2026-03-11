<script module lang="ts">
	/**
	 * Reactive sync status state for the side panel.
	 *
	 * Reads the WebSocket sync provider's connection status and exposes it as
	 * a Svelte 5 `$state` value. The extension fires `onStatusChange` on every
	 * transition, and this module converts those callbacks into a reactive
	 * value the UI can bind to.
	 *
	 * Uses the same factory-function + singleton pattern as
	 * {@link savedTabState} — a `$state` value updated by extension callbacks,
	 * no polling, no derived stores.
	 */

	import type { SyncStatus } from '@epicenter/sync-client';
	import { reconnectSync, workspaceClient } from '$lib/workspace';

	function createSyncStatus() {
		let current = $state<SyncStatus>(workspaceClient.extensions.sync.status);

		workspaceClient.extensions.sync.onStatusChange((status) => {
			current = status;
		});

		return {
			/** Current sync connection status. */
			get current() {
				return current;
			},
		};
	}

	const syncStatus = createSyncStatus();

	function getTooltip(s: SyncStatus): string {
		switch (s.phase) {
			case 'connected':
				return 'Connected';
			case 'connecting':
				if (s.lastError?.type === 'auth')
					return 'Authentication failed—click to reconnect';
				if (s.attempt > 0) return `Reconnecting (attempt ${s.attempt})…`;
				return 'Connecting…';
			case 'offline':
				return 'Offline—click to reconnect';
		}
	}
</script>

<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import Cloud from '@lucide/svelte/icons/cloud';
	import CloudOff from '@lucide/svelte/icons/cloud-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';

	const tooltip = $derived(getTooltip(syncStatus.current));
</script>

<Button {tooltip} variant="ghost" size="icon-sm" onclick={reconnectSync}>
	{#if syncStatus.current.phase === 'connected'}
		<Cloud class="size-4" />
	{:else if syncStatus.current.phase === 'connecting'}
		<LoaderCircle class="size-4 animate-spin" />
	{:else}
		<CloudOff class="size-4 text-destructive" />
	{/if}
</Button>
