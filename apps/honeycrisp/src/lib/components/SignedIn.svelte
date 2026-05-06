<script lang="ts">
	import { getOrCreateInstallationId } from '@epicenter/workspace';
	import { onDestroy } from 'svelte';
	import { auth } from '$lib/auth';
	import { openHoneycrisp } from '$lib/honeycrisp/browser';
	import { createHoneycrispState, setHoneycrispState } from '$lib/state';
	import { setSignedIn } from '$lib/signed-in';
	import ErrorState from './ErrorState.svelte';
	import Loading from './Loading.svelte';

	let { children } = $props();

	if (auth.state.status !== 'signed-in') {
		throw new Error('<SignedIn> mounted outside signed-in scope');
	}

	const initialIdentity = auth.state.identity;
	let identity = $state(initialIdentity);

	const honeycrisp = openHoneycrisp({
		identity: initialIdentity,
		peer: {
			id: getOrCreateInstallationId(localStorage),
			name: 'Honeycrisp',
			platform: 'web',
		},
		bearerToken: () => auth.bearerToken,
	});
	const state = createHoneycrispState(honeycrisp);

	setHoneycrispState(state);

	$effect(() => {
		if (auth.state.status === 'signed-in') {
			identity = auth.state.identity;
			honeycrisp.encryption.applyKeys(auth.state.identity.encryptionKeys);
		}
	});

	onDestroy(() => {
		state.destroy();
		honeycrisp.dispose();
	});

	setSignedIn({
		get identity() {
			return identity;
		},
		get honeycrisp() {
			return honeycrisp;
		},
	});
</script>

{#await honeycrisp.whenReady}
	<Loading />
{:then}
	{@render children?.()}
{:catch error}
	<ErrorState {error} />
{/await}
