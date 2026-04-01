<script lang="ts">
	import WorkspaceGate from '@epicenter/svelte/workspace-gate';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { SvelteQueryDevtools } from '@tanstack/svelte-query-devtools';
	import { ModeWatcher, mode } from 'mode-watcher';
	import { Toaster } from 'svelte-sonner';
	import { queryClient } from '$lib/query/client';
	import { workspace } from '$lib/client';
	import '@epicenter/ui/app.css';
	import * as Tooltip from '@epicenter/ui/tooltip';

	let { children } = $props();
</script>

<svelte:head><title>Fuji</title></svelte:head>

<QueryClientProvider client={queryClient}>
	<WorkspaceGate whenReady={workspace.whenReady}>
		<Tooltip.Provider>{@render children()}</Tooltip.Provider>
	</WorkspaceGate>
</QueryClientProvider>

<Toaster offset={16} theme={mode.current} richColors closeButton />
<ModeWatcher defaultMode="dark" track={false} />
<SvelteQueryDevtools client={queryClient} buttonPosition="bottom-right" />
