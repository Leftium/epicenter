<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { MediaQuery } from 'svelte/reactivity';
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { rpc } from '$lib/query';
	import { services } from '$lib/services';
	import { migrateOldSettings } from '$lib/migration/migrate-settings';
	import AppLayout from './_components/AppLayout.svelte';
	import VerticalNav from './_components/VerticalNav.svelte';
	import BottomNav from './_components/BottomNav.svelte';

	// Migrate old monolithic settings blob to per-key stores (one-time, idempotent)
	migrateOldSettings();

	let { children } = $props();

	let sidebarOpen = $state(false);
	let unlistenNavigate: UnlistenFn | null = null;

	// Desktop (Tauri): always sidebar, collapses to icon rail when narrow.
	// Web: sidebar when wide, bottom bar on phone-width viewports.
	const isTauri = !!window.__TAURI_INTERNALS__;
	const isNarrow = new MediaQuery('(max-width: 767px)');
	const showBottomBar = $derived(!isTauri && isNarrow.current);

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
		if (!isTauri) return;
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

{#if showBottomBar}
	<div class="flex h-full min-h-svh flex-col">
		<div class="flex-1 pb-14">
			<AppLayout> {@render children()} </AppLayout>
		</div>
		<BottomNav />
	</div>
{:else}
	<Sidebar.Provider bind:open={sidebarOpen}>
		<VerticalNav />
		<Sidebar.Inset>
			<AppLayout> {@render children()} </AppLayout>
		</Sidebar.Inset>
	</Sidebar.Provider>
{/if}
