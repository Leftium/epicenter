<script lang="ts">
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { Button } from '@epicenter/ui/button';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { auth } from '$platform/auth';
	import { session } from '$lib/session.svelte';
	import FujiAppShell from './components/FujiAppShell.svelte';

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

{#if current.status === 'signed-in'}
	<WorkspaceGate
		pending={current.signedIn.fuji.idb.whenLoaded}
		onSignOut={() => auth.signOut()}
	>
		<FujiAppShell>{@render children?.()}</FujiAppShell>
	</WorkspaceGate>
{:else}
	<div
		class="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center"
	>
		<div class="space-y-1">
			<p class="text-sm font-medium">Sign in to Fuji</p>
			<p class="text-xs text-muted-foreground">
				Sync your entries across devices.
			</p>
		</div>
		{#if signInError}
			<p class="text-xs text-destructive">{signInError}</p>
		{/if}
		<Button class="w-full max-w-xs" onclick={startSignIn} disabled={signingIn}>
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
