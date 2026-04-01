<script lang="ts">
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from 'svelte-sonner';
	import { workspace } from '$lib/client';
	import '../app.css';

	let { children } = $props();
</script>

<ConfirmationDialog />
<Toaster richColors />
<WorkspaceGate whenReady={workspace.whenReady}>
	{@render children()}
</WorkspaceGate>
