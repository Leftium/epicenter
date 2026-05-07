<script lang="ts">
	import { AuthForm } from '@epicenter/svelte/auth-form';
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { auth } from '$lib/auth';
	import { session } from '$lib/session.svelte';
	import '../app.css';

	let { children } = $props();

	const current = $derived(session.current);
</script>

<ConfirmationDialog />
<Toaster />
<ModeWatcher />

{#if current.status === 'pending'}
	<Loading class="h-dvh" />
{:else if current.status === 'signed-out'}
	<div class="flex h-dvh items-center justify-center">
		<AuthForm
			{auth}
			syncNoun="notes"
			onSocialSignIn={() =>
				auth.signInWithSocialRedirect({
					provider: 'google',
					callbackURL: window.location.origin,
				})}
		/>
	</div>
{:else}
	<WorkspaceGate
		pending={current.signedIn.workspace.idb.whenLoaded}
		onSignOut={() => auth.signOut()}
	>
		{@render children()}
	</WorkspaceGate>
{/if}
