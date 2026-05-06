<script lang="ts">
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { Button } from '@epicenter/ui/button';
	import { getOrCreateInstallationId } from '@epicenter/workspace';
	import { onDestroy } from 'svelte';
	import { auth } from '$lib/auth';
	import { openHoneycrisp } from '$lib/honeycrisp/browser';
	import { setSignedIn } from '$lib/signed-in';
	import { createHoneycrispState, setHoneycrispState } from '$lib/state';

	let { children } = $props();

	if (auth.state.status !== 'signed-in') {
		throw new Error('<SignedIn> mounted outside signed-in scope');
	}

	const initialIdentity = auth.state.identity;
	// Snapshot identity into $state so the gate keeps serving the last-known
	// identity to children during the sign-out tear-down frame, rather than
	// reading auth.state.identity live (which would crash once status flips).
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
	const honeycrispState = createHoneycrispState(honeycrisp);

	setHoneycrispState(honeycrispState);

	$effect(() => {
		if (auth.state.status === 'signed-in') {
			identity = auth.state.identity;
			honeycrisp.encryption.applyKeys(auth.state.identity.encryptionKeys);
		}
	});

	onDestroy(() => {
		honeycrispState[Symbol.dispose]();
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

<WorkspaceGate pending={honeycrisp.whenReady}>
	{@render children?.()}

	{#snippet errorActions()}
		<div class="flex items-center gap-2">
			<Button variant="outline" onclick={() => window.location.reload()}>
				Reload
			</Button>
			<Button onclick={() => auth.signOut()}>Sign out</Button>
		</div>
	{/snippet}
</WorkspaceGate>
