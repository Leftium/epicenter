<script lang="ts">
	import { getOrCreateInstallationId } from '@epicenter/workspace';
	import { onDestroy } from 'svelte';
	import { auth } from '$lib/auth';
	import { entriesState } from '$lib/entries-state.svelte';
	import { openFuji } from '$lib/fuji/browser';
	import { setSignedIn } from '$lib/signed-in';
	import ErrorState from './ErrorState.svelte';
	import Loading from './Loading.svelte';

	let { children } = $props();

	if (auth.state.status !== 'signed-in') {
		throw new Error('<SignedIn> mounted outside signed-in scope');
	}

	const initialIdentity = auth.state.identity;
	let identity = $state(initialIdentity);

	const fuji = openFuji({
		identity: initialIdentity,
		peer: {
			id: getOrCreateInstallationId(localStorage),
			name: 'Fuji',
			platform: 'web',
		},
		bearerToken: () => auth.bearerToken,
	});

	entriesState.bind(fuji);

	$effect(() => {
		if (auth.state.status === 'signed-in') {
			identity = auth.state.identity;
			fuji.encryption.applyKeys(auth.state.identity.encryptionKeys);
		}
	});

	onDestroy(() => {
		entriesState.destroy();
		fuji.dispose();
	});

	setSignedIn({
		get identity() {
			return identity;
		},
		get fuji() {
			return fuji;
		},
	});
</script>

{#await fuji.whenReady}
	<Loading />
{:then}
	{@render children?.()}
{:catch error}
	<ErrorState {error} />
{/await}
