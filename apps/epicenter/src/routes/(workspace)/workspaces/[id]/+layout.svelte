<script lang="ts">
	import { onDestroy } from 'svelte';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import WorkspaceSidebar from '$lib/components/WorkspaceSidebar.svelte';
	import HeaderBreadcrumbs from '$lib/components/HeaderBreadcrumbs.svelte';

	let { data, children } = $props();

	onDestroy(() => {
		data.client.destroy();
	});
</script>

<Sidebar.Provider>
	<WorkspaceSidebar />
	<Sidebar.Inset>
		<header class="flex h-12 items-center gap-2 border-b px-4">
			<Sidebar.Trigger />
			<HeaderBreadcrumbs />
		</header>
		<main class="flex-1 p-4">
			{@render children()}
		</main>
	</Sidebar.Inset>
</Sidebar.Provider>
