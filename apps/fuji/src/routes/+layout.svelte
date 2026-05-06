<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { auth } from '$lib/auth';
	import '@epicenter/ui/app.css';

	let { children } = $props();
</script>

<svelte:head><title>Fuji</title></svelte:head>

{#if auth.state.status === 'pending'}
	<Loading class="h-dvh" />
{:else}
	{@render children?.()}
{/if}

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
