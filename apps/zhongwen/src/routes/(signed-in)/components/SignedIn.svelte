<script lang="ts">
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { onDestroy } from 'svelte';
	import { auth } from '$lib/auth';
	import { setSignedIn } from '../signed-in';
	import { openZhongwen } from '../zhongwen/browser';

	let { children } = $props();

	// Type-narrowing assertion. The (signed-in)/+layout.svelte parent already
	// gates on `status === 'signed-in'`, so this throw is unreachable in
	// practice; it exists so TypeScript narrows auth.state.identity below.
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

	onDestroy(() => zhongwen[Symbol.dispose]());

	setSignedIn({
		get identity() {
			return identity;
		},
		get zhongwen() {
			return zhongwen;
		},
	});
</script>

<WorkspaceGate
	pending={zhongwen.idb.whenLoaded}
	onSignOut={() => auth.signOut()}
>
	{@render children?.()}
</WorkspaceGate>
