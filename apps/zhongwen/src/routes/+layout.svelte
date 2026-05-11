<script lang="ts">
	import '../app.css';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { auth } from '$platform/auth';

	let { children } = $props();
</script>

<Toaster />
<ConfirmationDialog />
<ModeWatcher />
{#if auth.state.status === 'pending'}
	<Loading class="h-dvh" />
{:else}
	{@render children?.()}
{/if}
