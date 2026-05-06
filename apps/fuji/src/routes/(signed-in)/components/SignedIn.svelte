<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import { getOrCreateInstallationId } from '@epicenter/workspace';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy } from 'svelte';
	import { auth } from '$lib/auth';
	import { openFuji } from '../fuji/browser';
	import { setSignedIn } from '../signed-in';
	import { createEntriesState, setEntriesState } from '../state/entries.svelte';

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
		fuji[Symbol.dispose]();
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
	<Empty.Root class="h-dvh flex-none border-0" aria-live="polite">
		<Empty.Media>
			<Spinner class="size-5 text-muted-foreground" />
		</Empty.Media>
	</Empty.Root>
{:then _}
	{@render children?.()}
{:catch error}
	<!--
		Inlined per app on purpose. Honeycrisp and Zhongwen carry the same
		Empty.Root + Reload + Sign out markup verbatim. The duplication is
		acknowledged: each app keeps freedom to evolve loading/error chrome
		(brand mark, spinner, additional actions) without negotiating with a
		shared component. See specs/20260506T020000-expose-attachments-not-aliases.md.
	-->
	<Empty.Root class="h-dvh flex-none border-0">
		<Empty.Media>
			<TriangleAlertIcon class="size-8 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>Failed to load workspace</Empty.Title>
		<Empty.Description>
			{error instanceof Error
				? error.message
				: 'The workspace could not be opened.'}
		</Empty.Description>
		<Empty.Content>
			<div class="flex items-center gap-2">
				<Button variant="outline" onclick={() => window.location.reload()}>
					Reload
				</Button>
				<Button onclick={() => auth.signOut()}>Sign out</Button>
			</div>
		</Empty.Content>
	</Empty.Root>
{/await}
