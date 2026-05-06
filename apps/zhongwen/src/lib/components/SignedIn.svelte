<script lang="ts">
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { Button } from '@epicenter/ui/button';
	import { onDestroy } from 'svelte';
	import { auth } from '$lib/auth';
	import { setSignedIn } from '$lib/signed-in';
	import { openZhongwen } from '$lib/zhongwen/browser';

	let { children } = $props();

	if (auth.state.status !== 'signed-in') {
		throw new Error('<SignedIn> mounted outside signed-in scope');
	}

	const initialIdentity = auth.state.identity;
	// Snapshot identity into $state so the gate keeps serving the last-known
	// identity to children during the sign-out tear-down frame, rather than
	// reading auth.state.identity live (which would crash once status flips).
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

<WorkspaceGate pending={zhongwen.whenReady}>
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
