<script lang="ts">
	import type { AuthClient, InstanceSetting } from '@epicenter/auth';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';

	let {
		auth,
		setting,
		disabledReason,
		onConfigure,
		class: className,
	}: {
		/** The app's auth client; its `startSignIn` drives the primary button. */
		auth: AuthClient;
		/** The shared instance setting handle this app injected. */
		setting: InstanceSetting;
		/**
		 * When set, the primary sign-in and the "connect/change" link are disabled.
		 * Lets a host block a page-reloading account change at an unsafe moment, e.g.
		 * Whispering during a recording. Omit to leave the actions enabled.
		 */
		disabledReason?: string;
		/**
		 * Open the instance-settings modal. The shell owns that modal, not this
		 * component, because its lifetime differs: inline on a full-page screen, but
		 * root-mounted beside a popover (so closing the popover cannot tear an open
		 * modal down).
		 */
		onConfigure: () => void;
		/** Layout classes for the action column (width, alignment). */
		class?: string;
	} = $props();

	let signingIn = $state(false);
	let signInError = $state<string | null>(null);
	const accountLocked = $derived(!!disabledReason);
	// A self-host override is configured (a non-hosted star with a token is
	// persisted, ADR-0071), which flips the labels from "sign in / connect" to
	// "retry / change". Reads the boot snapshot, which only changes across a reload.
	const configured = $derived(!setting.isDefault());

	// The self-host token client reports why it is not connected; hosted OAuth has
	// no such channel (`auth.connection` is undefined) and falls back to the
	// generic startSignIn error rendered below.
	const host = $derived(new URL(setting.read().baseURL).host);
	const connectionState = $derived(auth.connection?.state);
	const connectionNotice = $derived.by(() => {
		const c = connectionState;
		if (!c) return null;
		switch (c.status) {
			case 'pending':
				return { text: `Connecting to ${host}…`, tone: 'text-muted-foreground' };
			case 'failed':
				return {
					text:
						c.reason === 'rejected'
							? `${host} rejected the saved token.`
							: `Couldn't reach ${host}. Check the URL and that your server is running.`,
					tone: 'text-destructive',
				};
			case 'connected':
				return null;
		}
	});
	// Busy while the boot check is still verifying or a manual retry is in flight.
	// A pending boot check has no ceiling here: `fetch` has no default timeout, so
	// a star that accepts the socket but never answers leaves this on "Connecting…"
	// until the browser's own timeout fires. Refused connections and 401s fail
	// fast, so the common failures self-heal into a retryable state.
	const verifying = $derived(signingIn || connectionState?.status === 'pending');

	// One sign-in surface: the primary button and the "retry" action are the same
	// `auth.startSignIn()`, whose meaning (hosted OAuth vs. verifying the persisted
	// token) is fixed by the constructed client, so the label follows `configured`.
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

<div class={cn('flex flex-col gap-3', className)}>
	{#if connectionNotice}
		<p class="text-xs {connectionNotice.tone}">{connectionNotice.text}</p>
	{:else if signInError}
		<p class="text-xs text-destructive">{signInError}</p>
	{/if}
	<Button class="w-full" disabled={verifying || accountLocked} onclick={startSignIn}>
		{#if verifying}
			<Spinner class="size-4" />
			{configured ? 'Connecting…' : 'Signing in…'}
		{:else if auth.state.status === 'reauth-required'}
			Reconnect
		{:else}
			{configured ? 'Retry connection' : 'Sign in with Epicenter'}
		{/if}
	</Button>
	<Button
		variant="link"
		size="sm"
		class="text-muted-foreground"
		disabled={accountLocked}
		onclick={onConfigure}
	>
		{configured ? 'Change instance' : 'Connect to a self-hosted instance'}
	</Button>
</div>
