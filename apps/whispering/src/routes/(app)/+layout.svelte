<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { onDestroy } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import AppLayout from './_components/AppLayout.svelte';
	import BottomNav from './_components/BottomNav.svelte';
	import VerticalNav from './_components/VerticalNav.svelte';
	import { runtimeOwners } from './_layout-utils/runtime-owners';

	let { children } = $props();

	let sidebarOpen = $state(false);
	const detachRuntimeOwners = runtimeOwners.map((owner) => owner.attach());

	// Sidebar when wide, bottom bar on narrow viewports (phone, small window).
	const isNarrow = new MediaQuery('(max-width: 767px)');

	onDestroy(() => {
		for (const detach of detachRuntimeOwners.toReversed()) detach();
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
