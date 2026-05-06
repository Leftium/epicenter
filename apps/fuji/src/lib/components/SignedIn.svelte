<script lang="ts">
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { Button } from '@epicenter/ui/button';
	import { getOrCreateInstallationId } from '@epicenter/workspace';
	import { onDestroy } from 'svelte';
	import { auth } from '$lib/auth';
	import { createEntriesState, setEntriesState } from '$lib/entries-state.svelte';
	import { openFuji } from '$lib/fuji/browser';
	import { setSignedIn } from '$lib/signed-in';

	let { children } = $props();

	if (auth.state.status !== 'signed-in') {
		throw new Error('<SignedIn> mounted outside signed-in scope');
	}

	const initialIdentity = auth.state.identity;
	// Snapshot identity into $state so the gate keeps serving the last-known
	// identity to children during the sign-out tear-down frame, rather than
	// reading auth.state.identity live (which would crash once status flips).
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

	const entriesState = createEntriesState(fuji);
	setEntriesState(entriesState);

	$effect(() => {
		if (auth.state.status === 'signed-in') {
			identity = auth.state.identity;
			fuji.encryption.applyKeys(auth.state.identity.encryptionKeys);
		}
	});

	onDestroy(() => {
		entriesState[Symbol.dispose]();
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

<WorkspaceGate pending={fuji.whenReady}>
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
