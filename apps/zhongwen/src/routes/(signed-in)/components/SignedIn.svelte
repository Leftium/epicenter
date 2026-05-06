<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
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

{#await zhongwen.idb.whenLoaded}
	<Empty.Root class="h-dvh flex-none border-0" aria-live="polite">
		<Empty.Media>
			<Spinner class="size-5 text-muted-foreground" />
		</Empty.Media>
	</Empty.Root>
{:then _}
	{@render children?.()}
{:catch error}
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
