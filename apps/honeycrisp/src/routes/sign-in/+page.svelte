<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { goto } from '$app/navigation';
	import { auth } from '$platform/auth';

	let signingIn = $state(false);
	let signInError = $state<string | null>(null);

	$effect(() => {
		if (auth.state.status === 'signed-in') {
			goto('/', { replaceState: true });
		}
	});

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

{#if auth.state.status !== 'signed-in'}
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
		<Button class="w-full max-w-xs" onclick={startSignIn} disabled={signingIn}>
			{#if signingIn}
				<LoaderCircle class="size-4 animate-spin" />
				Signing in…
			{:else if auth.state.status === 'reauth-required'}
				Reconnect
			{:else}
				Sign in with Epicenter
			{/if}
		</Button>
	</div>
{/if}
