<script lang="ts">
	import { Toaster } from '@epicenter/ui/sonner';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { ModeWatcher } from 'mode-watcher';
	import { onNavigate } from '$app/navigation';
	import { queryClient } from '$lib/rpc/client';
	import '@epicenter/ui/app.css';
	import * as Tooltip from '@epicenter/ui/tooltip';

	let { children } = $props();

	onNavigate((navigation) => {
		if (!document.startViewTransition) return;

		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});
</script>

<svelte:head> <title>Whispering</title> </svelte:head>

<QueryClientProvider client={queryClient}>
	<!-- Uses UI package defaults (300ms delay, 150ms skip) -->
	<Tooltip.Provider> {@render children()} </Tooltip.Provider>
</QueryClientProvider>

<Toaster
	offset={16}
	class="block"
	duration={5000}
	visibleToasts={5}
	closeButton
	toastOptions={{
		classes: {
			toast: 'flex flex-wrap *:data-content:flex-1',
			icon: 'shrink-0',
			actionButton: 'w-full mt-3 inline-flex justify-center',
			closeButton: 'w-full mt-3 inline-flex justify-center',
		},
	}}
/>
<ModeWatcher defaultMode="dark" track={false} />
