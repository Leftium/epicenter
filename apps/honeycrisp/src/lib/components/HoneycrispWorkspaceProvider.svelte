<script lang="ts">
	import type { AuthIdentity } from '@epicenter/auth';
	import { Spinner } from '@epicenter/ui/spinner';
	import { getOrCreateInstallationId } from '@epicenter/workspace';
	import { onDestroy, type Snippet } from 'svelte';
	import { auth } from '$lib/auth';
	import { openHoneycrisp } from '$lib/honeycrisp/browser';
	import { createHoneycrispState, setHoneycrispState } from '$lib/state';
	import { setHoneycrisp } from '$lib/workspace';

	let {
		identity,
		children,
	}: {
		identity: AuthIdentity;
		children: Snippet;
	} = $props();

	// svelte-ignore state_referenced_locally
	const honeycrisp = openHoneycrisp({
		identity,
		peer: {
			id: getOrCreateInstallationId(localStorage),
			name: 'Honeycrisp',
			platform: 'web',
		},
		transport: auth.openWebSocket,
	});
	const state = createHoneycrispState(honeycrisp);
	setHoneycrisp(honeycrisp);
	setHoneycrispState(state);

	const unsubscribe = auth.onStateChange((next) => {
		if (next.status === 'pending') return;
		if (next.status === 'signed-out') return window.location.reload();
		if (next.identity.user.id !== identity.user.id)
			return window.location.reload();
		honeycrisp.encryption.applyKeys(next.identity.encryptionKeys);
	});

	onDestroy(() => {
		unsubscribe();
		state.destroy();
		honeycrisp[Symbol.dispose]();
	});
</script>

{#await honeycrisp.whenLoaded}
	<div class="flex h-dvh items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{:then}
	{@render children()}
{/await}
