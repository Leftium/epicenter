<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { migrateOldSettings } from '$lib/migration/migrate-settings';
	import { analytics } from '$lib/operations/analytics';
	import { services } from '$lib/services';
	import { PROVIDERS } from '$lib/services/transcription/providers';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { localModel } from '$lib/state/local-model.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { tauri } from '#platform/tauri';
	import { commands, type Engine } from '$lib/tauri/commands';
	import AppLayout from './_components/AppLayout.svelte';
	import BottomNav from './_components/BottomNav.svelte';
	import VerticalNav from './_components/VerticalNav.svelte';

	// Migrate old monolithic settings blob to per-key stores (one-time, idempotent)
	migrateOldSettings();

	let { children } = $props();

	let sidebarOpen = $state(false);
	let unlistenNavigate: UnlistenFn | null = null;
	let unlistenLocalModel: UnlistenFn | null = null;

	const LOCAL_ENGINES = new Set<Engine>(['whispercpp', 'parakeet', 'moonshine']);
	function isLocalEngine(serviceId: string): serviceId is Engine {
		return LOCAL_ENGINES.has(serviceId as Engine);
	}

	// Sidebar when wide, bottom bar on narrow viewports (phone, small window).
	const isNarrow = new MediaQuery('(max-width: 767px)');

	$effect(() => {
		const unlisten = services.localShortcutManager.listen();
		return () => unlisten();
	});

	// Log app started event once on mount
	$effect(() => {
		analytics.logEvent({ type: 'app_started' });
	});

	// Push the ambient transcription config to Rust whenever it changes. Rust
	// owns the resident model lifecycle (cache, preload, eviction); the FE
	// just mirrors the current settings on a single channel.
	// - Drift in (engine, modelPath) triggers a background preload.
	// - Other field changes (language, prompt, unloadPolicy) take effect on
	//   the next transcription with no reload.
	// Fires once on mount (per local engine) and on every subsequent change.
	$effect(() => {
		if (!tauri) return;
		const service = settings.get('transcription.service');
		if (!isLocalEngine(service)) return;

		const modelPath = deviceConfig.get(PROVIDERS[service].modelPathKey);
		if (!modelPath) return;

		const language = settings.get('transcription.language');
		const prompt = settings.get('transcription.prompt');
		void commands
			.setTranscriptionConfig({
				engine: service,
				modelPath,
				language: language === 'auto' ? null : language,
				initialPrompt: prompt || null,
				unloadPolicy: deviceConfig.get('transcription.localModelUnloadPolicy'),
			})
			.catch((err) => {
				console.error('Failed to push transcription config to Rust:', err);
			});
	});

	// Listen for navigation events from other windows and subscribe to the
	// local-model lifecycle so any consumer (`localModel.isBusy`, etc.) can
	// react to load / inference / eviction events.
	onMount(async () => {
		if (!tauri) return;
		unlistenNavigate = await listen<{ path: string }>(
			'navigate-main-window',
			(event) => {
				goto(event.payload.path);
			},
		);
		unlistenLocalModel = await localModel.attach();
	});

	onDestroy(() => {
		unlistenNavigate?.();
		unlistenLocalModel?.();
	});
</script>

{#if isNarrow.current}
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
