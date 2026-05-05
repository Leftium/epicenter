<script lang="ts">
	import type { AuthIdentity } from '@epicenter/auth';
	import { Spinner } from '@epicenter/ui/spinner';
	import { getOrCreateInstallationId } from '@epicenter/workspace';
	import { onDestroy, type Snippet } from 'svelte';
	import { auth } from '$lib/auth';
	import { createEntriesState, setEntriesState } from '$lib/entries-state.svelte';
	import { openFuji } from '$lib/fuji/browser';
	import { setFuji } from '$lib/workspace';

	let {
		identity,
		children,
	}: {
		identity: AuthIdentity;
		children: Snippet;
	} = $props();

	const fuji = openFuji({
		identity,
		peer: {
			id: getOrCreateInstallationId(localStorage),
			name: 'Fuji',
			platform: 'web',
		},
		transport: auth.openWebSocket,
	});
	const entriesState = createEntriesState(fuji);
	setFuji(fuji);
	setEntriesState(entriesState);

	const unsubscribe = auth.onStateChange((state) => {
		if (state.status === 'pending') return;
		if (state.status === 'signed-out') return window.location.reload();
		if (state.identity.user.id !== identity.user.id)
			return window.location.reload();
		fuji.encryption.applyKeys(state.identity.encryptionKeys);
	});

	onDestroy(() => {
		unsubscribe();
		entriesState.destroy();
		fuji[Symbol.dispose]();
	});
</script>

{#await fuji.whenLoaded}
	<div class="flex h-dvh items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{:then}
	{@render children()}
{/await}
