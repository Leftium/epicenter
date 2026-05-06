<script lang="ts">
	import { onDestroy } from 'svelte';
	import { auth } from '$lib/auth';
	import { setSignedIn } from '$lib/signed-in';
	import { openZhongwen } from '$lib/zhongwen/browser';
	import ErrorState from './ErrorState.svelte';
	import Loading from './Loading.svelte';

	let { children } = $props();

	if (auth.state.status !== 'signed-in') {
		throw new Error('<SignedIn> mounted outside signed-in scope');
	}

	const initialIdentity = auth.state.identity;
	let identity = $state(initialIdentity);

	const zhongwen = openZhongwen({ identity: initialIdentity });

	$effect(() => {
		if (auth.state.status === 'signed-in') {
			identity = auth.state.identity;
			zhongwen.encryption.applyKeys(auth.state.identity.encryptionKeys);
		}
	});

	onDestroy(() => zhongwen.dispose());

	setSignedIn({
		get identity() {
			return identity;
		},
		get zhongwen() {
			return zhongwen;
		},
	});
</script>

{#await zhongwen.whenReady}
	<Loading />
{:then}
	{@render children?.()}
{:catch error}
	<ErrorState {error} />
{/await}
