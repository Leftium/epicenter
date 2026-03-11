<script module lang="ts">
	/**
	 * Reactive sync status state for the side panel.
	 *
	 * Reads the WebSocket sync provider's connection status and exposes it as
	 * a Svelte 5 `$state` value. The provider fires `onStatusChange` on every
	 * transition (`offline` → `connecting` → `connected`), and this module
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
	const label = $derived(
		syncStatus.current === 'connected'
			? 'Connected'
			: syncStatus.current === 'connecting'
				? 'Connecting…'
				: 'Offline',
	);

	const dotColor = $derived(
		syncStatus.current === 'connected'
			? 'bg-emerald-500'
			: syncStatus.current === 'connecting'
				? 'bg-yellow-500'
				: 'bg-muted-foreground/50',
	);

	const pulse = $derived(syncStatus.current === 'connecting');
</script>

<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
	<span class="relative flex size-2">
		{#if pulse}
			<span
				class="absolute inline-flex h-full w-full animate-ping rounded-full {dotColor} opacity-75"
			></span>
		{/if}
		<span class="relative inline-flex size-2 rounded-full {dotColor}"></span>
	</span>
	<span>{label}</span>
</div>
