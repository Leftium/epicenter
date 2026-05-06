<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import { getOrCreateInstallationId } from '@epicenter/workspace';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy } from 'svelte';
	import { auth } from '$lib/auth';
	import { entriesState } from '$lib/entries-state.svelte';
	import { openFuji } from '$lib/fuji/browser';
	import { setSignedIn } from '$lib/signed-in';

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

{#await fuji.idb.whenLoaded}
	<div class="flex h-dvh items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{:then}
	{@render children?.()}
{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Media>
			<TriangleAlertIcon class="size-8 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>Failed to load workspace</Empty.Title>
		<Empty.Description>
			{error instanceof Error
				? error.message
				: 'The workspace could not be opened.'}
		</Empty.Description>
		<div class="flex items-center gap-2">
			<Button variant="outline" onclick={() => window.location.reload()}>
				Reload
			</Button>
			<Button onclick={() => auth.signOut()}>Sign out</Button>
		</div>
	</Empty.Root>
{/await}
