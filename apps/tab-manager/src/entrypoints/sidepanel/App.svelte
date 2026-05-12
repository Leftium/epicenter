<script lang="ts">
	import { AuthForm } from '@epicenter/svelte/auth-form';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { ModeWatcher } from 'mode-watcher';
	import { tabManagerSession } from '$lib/session.svelte';
	import SignedInApp from './SignedInApp.svelte';

	const current = $derived(tabManagerSession.current);
</script>

{#await tabManagerSession.whenReady}
	<Loading class="h-full" label="Loading tabs…" />
{:then _}
	{#if current.status === 'pending'}
		<Loading class="h-full" label="Loading tabs…" />
	{:else if current.status === 'signed-out'}
		<main class="flex h-full items-center justify-center bg-background p-4">
			<AuthForm
				auth={tabManagerSession.auth}
				syncNoun="tabs"
				onSocialSignIn={() =>
					tabManagerSession.auth.signInWithSocial({ provider: 'google' })}
			/>
		</main>
	{:else}
		{#await current.signedIn.whenReady}
			<Loading class="h-full" label="Loading tabs…" />
		{:then _}
			<SignedInApp />
		{:catch _error}
			<Empty.Root class="h-full border-0">
				<Empty.Media>
					<TriangleAlertIcon class="size-8 text-muted-foreground" />
				</Empty.Media>
				<Empty.Title>Failed to load workspace</Empty.Title>
				<Empty.Description> Try reopening the side panel. </Empty.Description>
			</Empty.Root>
		{/await}
	{/if}
{:catch _error}
	<Empty.Root class="h-full border-0">
		<Empty.Media>
			<TriangleAlertIcon class="size-8 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>Failed to load account</Empty.Title>
		<Empty.Description> Try reopening the side panel. </Empty.Description>
	</Empty.Root>
{/await}

<ModeWatcher />
<Toaster position="bottom-center" richColors closeButton />
