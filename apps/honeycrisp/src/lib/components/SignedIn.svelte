<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import { getOrCreateInstallationId } from '@epicenter/workspace';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
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
		honeycrisp[Symbol.dispose]();
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

{#await honeycrisp.idb.whenLoaded}
	<div class="flex h-dvh items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{:then _}
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
