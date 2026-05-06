<script lang="ts">
	import '../app.css';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { WorkspaceLoading } from '@epicenter/svelte/workspace-loading';
	import { auth } from '$lib/auth';

	let { children } = $props();
</script>

<Toaster />
<ConfirmationDialog />
<ModeWatcher />
{#if auth.state.status === 'pending'}
	<WorkspaceLoading />
{:else}
	{@render children?.()}
{/if}
