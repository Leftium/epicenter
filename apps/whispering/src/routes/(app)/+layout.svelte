<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { rpc } from '$lib/query';
	import { services } from '$lib/services';
	import { settings } from '$lib/state/settings.svelte';
	import { migrateOldSettings } from '$lib/migration/migrate-settings';
	import AppLayout from './_components/AppLayout.svelte';
	import VerticalNav from './_components/VerticalNav.svelte';

	// Migrate old monolithic settings blob to per-key stores (one-time, idempotent)
	migrateOldSettings();

	let { children } = $props();

	let sidebarOpen = $state(false);
	let unlistenNavigate: UnlistenFn | null = null;

	$effect(() => {
		const unlisten = services.localShortcutManager.listen();
		return () => unlisten();
	});

	// Log app started event once on mount
	$effect(() => {
		rpc.analytics.logEvent({ type: 'app_started' });
	});

	// Listen for navigation events from other windows
	onMount(async () => {
		if (!window.__TAURI_INTERNALS__) return;
		unlistenNavigate = await listen<{ path: string }>(
			'navigate-main-window',
			(event) => {
				goto(event.payload.path);
			},
		);
	});

	onDestroy(() => {
		unlistenNavigate?.();
	});
</script>

<Sidebar.Provider bind:open={sidebarOpen}>
	{#if settings.get('ui.layoutMode') === 'sidebar'}
		<VerticalNav />
	{/if}
	<Sidebar.Inset> <AppLayout> {@render children()} </AppLayout> </Sidebar.Inset>
</Sidebar.Provider>
