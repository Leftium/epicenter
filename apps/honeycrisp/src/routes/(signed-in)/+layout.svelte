<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Tooltip from '@epicenter/ui/tooltip';
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
		<SignedIn>
			<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
		</SignedIn>
	{/key}
{/if}
