<script lang="ts">
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { Button } from '@epicenter/ui/button';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { SvelteQueryDevtools } from '@tanstack/svelte-query-devtools';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { ModeWatcher } from 'mode-watcher';
	import { auth } from '$platform/auth';
	import { queryClient } from '$lib/query/client';
	import { session } from '$lib/session.svelte';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	const current = $derived(session.current);

	let signingIn = $state(false);
	let signInError = $state<string | null>(null);

	async function startSignIn() {
		signInError = null;
		signingIn = true;
		try {
			const { error } = await auth.startSignIn({
				returnTo: window.location.href,
			});
			if (error) signInError = error.message;
		} finally {
			signingIn = false;
		}
	}
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

<QueryClientProvider client={queryClient}>
	{#if current.status === 'signed-in'}
		<WorkspaceGate
			pending={current.signedIn.honeycrisp.idb.whenLoaded}
			onSignOut={() => auth.signOut()}
		>
			<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
		</WorkspaceGate>
	{:else}
		<div
			class="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center"
		>
			<div class="space-y-1">
				<p class="text-sm font-medium">Sign in to Honeycrisp</p>
				<p class="text-xs text-muted-foreground">
					Sync your notes across devices.
				</p>
			</div>
			{#if signInError}
				<p class="text-xs text-destructive">{signInError}</p>
			{/if}
			<Button
				class="w-full max-w-xs"
				onclick={startSignIn}
				disabled={signingIn}
			>
				{#if signingIn}
					<LoaderCircle class="size-4 animate-spin" />
					Signing in…
				{:else if current.status === 'reauth-required'}
					Reconnect
				{:else}
					Sign in with Epicenter
				{/if}
			</Button>
		</div>
	{/if}
</QueryClientProvider>

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
<SvelteQueryDevtools client={queryClient} buttonPosition="bottom-right" />
