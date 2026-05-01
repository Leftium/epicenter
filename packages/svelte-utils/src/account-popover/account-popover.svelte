<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Popover from '@epicenter/ui/popover';
	import type { SyncAttachment, SyncStatus } from '@epicenter/workspace';
	import Cloud from '@lucide/svelte/icons/cloud';
	import CloudOff from '@lucide/svelte/icons/cloud-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import LogOut from '@lucide/svelte/icons/log-out';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import type { AuthClient } from '@epicenter/auth-svelte';
	import { AuthForm } from '../auth-form/index.js';

	/**
	 * Shared account popover.
	 *
	 * Renders sync status from a `SyncAttachment` (the concrete `attachSync`
	 * return type exposed as `workspace.sync`) alongside auth identity,
	 * reconnect, and sign-out. Sign-out asks for confirmation when
	 * unsynced work exists.
	 *
	 * Mount once in each app's root layout alongside `<ConfirmationDialog />`.
	 */
	type AccountPopoverProps = {
		/** The auth client from `createAuth()`. */
		auth: AuthClient;
		/** The workspace's `attachSync` result, typically `workspace.sync`. */
		sync: SyncAttachment;
		/**
		 * Wipe local persistence (IndexedDB). Called as part of sign-out;
		 * typically `() => workspace.idb.clearLocal()`.
		 */
		clearLocalData: () => Promise<void>;
		/** Noun describing what gets synced, e.g. "tabs" or "notes". */
		syncNoun: string;
		/** Handler called when the user clicks "Continue with Google". */
		onSocialSignIn: () => Promise<{ error: { message: string } | null }>;
	};

	let {
		auth,
		sync,
		clearLocalData,
		syncNoun,
		onSocialSignIn,
	}: AccountPopoverProps = $props();

	let syncStatus = $state<SyncStatus>(sync.status);
	let popoverOpen = $state(false);
	let signingOut = $state(false);
	const snapshot = $derived(auth.snapshot);
	const isSignedIn = $derived(snapshot.status === 'signedIn');

	$effect(() => {
		syncStatus = sync.status;
		const unsubscribe = sync.onStatusChange((status) => {
			syncStatus = status;
		});
		return unsubscribe;
	});

	/**
	 * Tooltip string for the trigger pill, derived from sync phase + auth.
	 */
	function getSyncTooltip(s: SyncStatus, isAuthenticated: boolean): string {
		if (!isAuthenticated) return 'Sign in to sync across devices';
		switch (s.phase) {
			case 'connected':
				return 'Connected';
			case 'connecting':
				if (s.lastError?.type === 'auth')
					return 'Authentication failed. Click to reconnect';
				if (s.retries > 0) return `Reconnecting (retry ${s.retries})…`;
				return 'Connecting…';
			case 'offline':
				return 'Offline. Click to reconnect';
			case 'failed':
				return 'Sync failed';
		}
	}

	const tooltip = $derived(getSyncTooltip(syncStatus, isSignedIn));

	/**
	 * Safe sign-out gate. Connected + fully synced → sign out immediately.
	 * Otherwise warn about unsynced work first.
	 *
	 * Sequence: `auth.signOut()` → `clearLocalData()` → `reload()`. The
	 * reload atomically resets Y.Doc, encryption keys, Svelte stores, and
	 * BroadcastChannel. That is simpler than teardown coordination.
	 */
	function handleSignOut() {
		const current = sync.status;
		const isSynced =
			current.phase === 'connected' && !current.hasLocalChanges;

		const doSignOut = async () => {
			signingOut = true;
			try {
				await auth.signOut();
				await clearLocalData();
				window.location.reload();
			} finally {
				signingOut = false;
			}
		};

		if (isSynced) {
			doSignOut();
		} else {
			confirmationDialog.open({
				title: 'Sign out with unsynced changes?',
				description:
					"Some changes haven't synced to the cloud yet. Signing out will lose them.",
				confirm: { text: 'Sign out anyway', variant: 'destructive' },
				cancel: { text: 'Stay signed in' },
				onConfirm: doSignOut,
			});
		}

		popoverOpen = false;
	}
</script>

<Popover.Root bind:open={popoverOpen}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon-sm"
				{tooltip}
			>
				<div class="relative">
					{#if signingOut}
						<LoaderCircle class="size-4 animate-spin" />
					{:else if !isSignedIn}
						<CloudOff class="size-4 text-muted-foreground" />
					{:else if syncStatus.phase === 'connected'}
						<Cloud class="size-4" />
					{:else if syncStatus.phase === 'connecting'}
						<LoaderCircle class="size-4 animate-spin" />
					{:else}
						<CloudOff class="size-4 text-destructive" />
					{/if}
					{#if !isSignedIn}
						<span
							class="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary"
						></span>
					{/if}
				</div>
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 p-0" align="end">
		{#if snapshot.status === 'signedIn'}
			<div class="p-4 space-y-3">
				<div class="space-y-1">
					<p class="text-sm font-medium">{snapshot.session.user.name}</p>
					<p class="text-xs text-muted-foreground">{snapshot.session.user.email}</p>
				</div>
				<div class="border-t pt-3 space-y-1">
					<p class="text-xs text-muted-foreground">
						Sync:
						{({
							connected: 'Connected',
							connecting: 'Connecting…',
							offline: 'Offline',
							failed: 'Failed',
						} satisfies Record<SyncStatus['phase'], string>)[syncStatus.phase]}
					</p>
				</div>
				<div class="border-t pt-3 flex gap-2">
					{#if syncStatus.phase !== 'connected'}
						<Button
							variant="outline"
							size="sm"
							class="flex-1"
							onclick={() => sync.reconnect()}
						>
							<RefreshCw class="size-3.5" />
							Reconnect
						</Button>
					{/if}
					<Button
						variant="ghost"
						size="sm"
						class="flex-1"
						onclick={handleSignOut}
					>
						<LogOut class="size-3.5" />
						Sign out
					</Button>
				</div>
			</div>
		{:else if snapshot.status === 'signedOut'}
			<div class="flex items-center justify-center p-4">
				<AuthForm {auth} {syncNoun} {onSocialSignIn} />
			</div>
		{:else}
			<div class="flex items-center justify-center p-4">
				<LoaderCircle class="size-4 animate-spin text-muted-foreground" />
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
