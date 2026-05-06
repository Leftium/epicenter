<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { auth } from '$lib/auth';
	import SignedIn from '$lib/components/SignedIn.svelte';

	let { children } = $props();

	$effect(() => {
		if (auth.state.status === 'signed-out' && page.url.pathname !== '/sign-in') {
			goto('/sign-in', { replaceState: true });
		}
	});
</script>

{#if auth.state.status === 'signed-in'}
	{#key auth.state.identity.user.id}
		<SignedIn>{@render children?.()}</SignedIn>
	{/key}
{/if}
