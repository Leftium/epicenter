<script lang="ts">
	import AppShell from '$lib/components/AppShell.svelte';
	import { workspaceAuth } from '$lib/workspace.svelte';

	workspaceAuth.mount();
</script>

<AppShell />
