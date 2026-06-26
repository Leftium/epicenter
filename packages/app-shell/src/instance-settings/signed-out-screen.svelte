<script lang="ts">
	import type { InstanceSetting, SyncAuthClient } from '@epicenter/auth';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import InstanceSettingsModal from './instance-settings-modal.svelte';

	let {
		appName,
		tagline,
		auth,
		setting,
		class: className = 'h-dvh',
	}: {
		/** The app's display name, shown in the hosted sign-in heading. */
		appName: string;
		/** One-line hosted sign-in subheading (e.g. "Sync your notes across devices."). */
		tagline: string;
		/** The app's auth client; its `startSignIn` drives the button. */
		auth: SyncAuthClient;
		/** The shared instance setting handle this app injected. */
		setting: InstanceSetting;
		/**
		 * Container sizing/background classes. Defaults to a full-viewport page
		 * gate; an extension side panel injects its own height chain and
		 * background (e.g. "h-full bg-background").
		 */
		class?: string;
	} = $props();

	let signingIn = $state(false);
	let signInError = $state<string | null>(null);
	let instanceModalOpen = $state(false);

	// A token override flips the copy from "sign in" to "connect". Derived reads
	// of the stable handle; saving the modal reloads, so nothing changes live.
	const usingToken = $derived(setting.read().token !== undefined);
	const instanceHost = $derived(new URL(setting.read().baseURL).host);

	async function startSignIn() {
		signInError = null;
		signingIn = true;
		try {
			const { error } = await auth.startSignIn();
			if (error) signInError = error.message;
		} finally {
			signingIn = false;
		}
	}
</script>

<div
	class={cn(
		'flex flex-col items-center justify-center gap-3 px-6 text-center',
		className,
	)}
>
	<div class="space-y-1">
		<p class="text-sm font-medium">
			{usingToken ? `Connect to ${instanceHost}` : `Sign in to ${appName}`}
		</p>
		<p class="text-xs text-muted-foreground">
			{usingToken ? 'Sign in to your self-hosted instance.' : tagline}
		</p>
	</div>
	{#if signInError}
		<p class="text-xs text-destructive">{signInError}</p>
	{/if}
	<Button class="w-full max-w-xs" disabled={signingIn} onclick={startSignIn}>
		{#if signingIn}
			<Spinner class="size-4" />
			{usingToken ? 'Connecting…' : 'Signing in…'}
		{:else}
			{usingToken ? 'Retry connection' : 'Sign in with Epicenter'}
		{/if}
	</Button>
	<Button
		variant="link"
		size="sm"
		class="text-muted-foreground"
		onclick={() => (instanceModalOpen = true)}
	>
		{setting.isDefault()
			? 'Connect to a self-hosted instance'
			: 'Change instance'}
	</Button>
</div>

<InstanceSettingsModal bind:open={instanceModalOpen} {appName} {setting} />
