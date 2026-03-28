<script lang="ts">
	import { onMount } from 'svelte';
	import AppShell from '$lib/components/AppShell.svelte';
	import { ws } from '$lib/workspace.svelte';

	onMount(() => {
		void ws.bootFromCache();
	});
</script>

<AppShell />
