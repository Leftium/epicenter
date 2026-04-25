<script lang="ts">
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { opensidian } from '$lib/client.svelte';
	import '../app.css';

	let { children } = $props();
</script>

<ConfirmationDialog />
<Toaster />
<ModeWatcher />
<WorkspaceGate whenReady={opensidian.whenReady}>
	{@render children()}
</WorkspaceGate>
