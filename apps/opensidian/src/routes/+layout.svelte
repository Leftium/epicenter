<script lang="ts">
	import WorkspaceGate from '@epicenter/svelte/workspace-gate';
	import { Toaster } from 'svelte-sonner';
	import { workspace } from '$lib/workspace';
	import '../app.css';

	let { children } = $props();
</script>

<Toaster richColors />
<WorkspaceGate whenReady={workspace.whenReady}>
	{@render children()}
</WorkspaceGate>
