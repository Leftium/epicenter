<script lang="ts">
	import type { InstanceSetting, SyncAuthClient } from '@epicenter/auth';
	import { cn } from '@epicenter/ui/utils';
	import InstanceSettingsModal from './instance-settings-modal.svelte';
	import InstanceSignIn from './instance-sign-in.svelte';

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

	let modalOpen = $state(false);

	// A token override flips the heading from "sign in" to "connect". Derived reads
	// of the stable handle; saving the modal reloads, so nothing changes live. The
	// sign-in actions themselves live in the shared {@link InstanceSignIn}.
	const usingToken = $derived(!setting.isDefault());
	const instanceHost = $derived(new URL(setting.read().baseURL).host);
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
	<InstanceSignIn
		{auth}
		{setting}
		onConfigure={() => (modalOpen = true)}
		class="w-full max-w-xs"
	/>
</div>

<InstanceSettingsModal bind:open={modalOpen} {appName} {setting} />
