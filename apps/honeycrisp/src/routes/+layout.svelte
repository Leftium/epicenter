<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { SvelteQueryDevtools } from '@tanstack/svelte-query-devtools';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { ModeWatcher, mode } from 'mode-watcher';
	import { Toaster } from 'svelte-sonner';
	import { queryClient } from '$lib/query/client';
	import workspaceClient from '$lib/workspace';
	import '@epicenter/ui/app.css';
	import * as Tooltip from '@epicenter/ui/tooltip';

	let { children } = $props();
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

<QueryClientProvider client={queryClient}>
	{#await workspaceClient.whenReady}
		<div class="flex h-screen items-center justify-center">
			<div class="flex flex-col items-center gap-3">
				<Spinner class="size-5 text-muted-foreground" />
				<p class="text-sm text-muted-foreground">Loading workspace…</p>
			</div>
		</div>
	{:then}
		<Tooltip.Provider>{@render children()}</Tooltip.Provider>
	{:catch}
		<div class="flex h-screen items-center justify-center">
			<Empty.Root>
				<Empty.Media>
					<TriangleAlertIcon class="size-8 text-muted-foreground" />
				</Empty.Media>
				<Empty.Title>Failed to load workspace</Empty.Title>
				<Empty.Description>
					Something went wrong initializing the workspace. Try refreshing the
					page.
				</Empty.Description>
			</Empty.Root>
		</div>
	{/await}
</QueryClientProvider>

<Toaster offset={16} theme={mode.current} richColors closeButton />
<ModeWatcher defaultMode="dark" track={false} />
<SvelteQueryDevtools client={queryClient} buttonPosition="bottom-right" />
