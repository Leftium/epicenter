<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import HomeSidebar from '$lib/components/HomeSidebar.svelte';

	let { children } = $props();
</script>

<Sidebar.Provider>
	<HomeSidebar />
	<Sidebar.Inset>
		<header class="flex h-12 items-center gap-2 border-b px-4">
			<Sidebar.Trigger />
			<h1 class="text-sm font-medium">Workspaces</h1>
		</header>
		<main class="flex-1 p-4">
			{@render children()}
		</main>
	</Sidebar.Inset>
</Sidebar.Provider>
