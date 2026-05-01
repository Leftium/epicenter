<script lang="ts">
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Popover from '@epicenter/ui/popover';
	/**
	 * @deprecated Use `AccountPopover` from `@epicenter/svelte/account-popover`.
	 *
	 * This component is kept for the migration window only. It is structurally
	 * coupled to the legacy extension-chain workspace shape
	 * (`workspace.extensions.sync.*`, `workspace.clearLocalData()`). Migrated
	 * apps pass `sync={workspace.sync}` + `clearLocalData={() => workspace.idb.clearLocal()}`
	 * to `AccountPopover` directly. Deleted once every app migrates.
	 *
	 * Shared account + sync status popover used across all workspace apps.
	 */
	import type { SyncStatus } from '@epicenter/workspace';
	import Cloud from '@lucide/svelte/icons/cloud';
	import CloudOff from '@lucide/svelte/icons/cloud-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import LogOut from '@lucide/svelte/icons/log-out';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import type { AuthClient } from '@epicenter/auth-svelte';
	import { AuthForm } from '../auth-form/index.js';

	type SyncStatusPopoverProps = {
		/** The auth client instance from `createAuth()`. */
		auth: AuthClient;
		/** Workspace with sync extension, used for status checks and cleanup. */
		workspace: {
			extensions: {
				sync: {
					status: SyncStatus;
					onStatusChange: (
						listener: (status: SyncStatus) => void,
					) => () => void;
					reconnect: () => void;
				};
			};
			clearLocalData: () => Promise<void>;
		};
		/** Noun describing what gets synced, e.g. "tabs" or "notes". */
		syncNoun: string;
		/**
		 * Social sign-in handler called when the user clicks "Continue with Google".
		 * Return shape matches `auth.signInWithSocialRedirect()`.
		 */
		onSocialSignIn: () => Promise<{ error: { message: string } | null }>;
	};

	let { auth, workspace, syncNoun, onSocialSignIn }: SyncStatusPopoverProps =
		$props();

	let syncStatus = $state<SyncStatus>(workspace.extensions.sync.status);
	let popoverOpen = $state(false);
	let signingOut = $state(false);
	const snapshot = $derived(auth.snapshot);
	const isSignedIn = $derived(snapshot.status === 'signedIn');

	$effect(() => {
		syncStatus = workspace.extensions.sync.status;
		const unsubscribe = workspace.extensions.sync.onStatusChange((status) => {
			syncStatus = status;
		});
		return unsubscribe;
	});

	/**
	 * Compute the tooltip string for the popover trigger based on
	 * sync connection phase and auth state.
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
	 * Safe sign-out flow that checks sync status before proceeding.
	 *
	 * If all local changes have been acknowledged by the server
	 * (`phase === 'connected' && !hasLocalChanges`), signs out immediately.
	 * Otherwise, shows a confirmation dialog warning about unsynced changes.
	 *
	 * The sign-out sequence: `auth.signOut()` → `workspace.clearLocalData()`
	 * → `window.location.reload()`. The page reload atomically clears all
	 * in-memory state (Y.Doc, encryption keys, Svelte stores, BroadcastChannel).
	 */
	function handleSignOut() {
		const status = workspace.extensions.sync.status;
		const isSynced = status.phase === 'connected' && !status.hasLocalChanges;

		const doSignOut = async () => {
			signingOut = true;
			try {
				await auth.signOut();
				await workspace.clearLocalData();
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
	<Popover.Trigger
		class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
		title={tooltip}
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
							onclick={() =>
								workspace.extensions.sync.reconnect()}
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
