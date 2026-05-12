<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { auth } from '$platform/auth';

	let errorMessage = $state<string | null>(null);

	onMount(() => {
		void finishSignIn();
	});

	async function finishSignIn() {
		const { error } = await auth.signInWithSocial({ provider: 'google' });
		if (error) {
			errorMessage = error.message;
			return;
		}
		await goto(`${base}/`, { replaceState: true });
	}
</script>

{#if errorMessage}
	<div class="flex h-dvh items-center justify-center px-6 text-center text-sm text-muted-foreground">
		{errorMessage}
	</div>
{:else}
	<div class="flex h-dvh items-center justify-center px-6 text-center text-sm text-muted-foreground">
		Signing in
	</div>
{/if}
