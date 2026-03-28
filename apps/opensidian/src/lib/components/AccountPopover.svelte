<script lang="ts">
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import Cloud from '@lucide/svelte/icons/cloud';
	import CloudOff from '@lucide/svelte/icons/cloud-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import LogOut from '@lucide/svelte/icons/log-out';
	import AuthForm from '$lib/components/AuthForm.svelte';
	import { auth } from '$lib/workspace';

	const isSignedIn = $derived(auth.session.status === 'authenticated');
	const isChecking = $derived(
		auth.operation.status === 'signing-in',
	);
	const currentUser = $derived(
		auth.session.status === 'authenticated' ? auth.session.user : null,
	);

	let popoverOpen = $state(false);
</script>

<Popover.Root bind:open={popoverOpen}>
	<Popover.Trigger
		class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
		title={isSignedIn ? 'Account' : 'Sign in to sync across devices'}
	>
		{#if isChecking}
			<LoaderCircle class="size-4 animate-spin" />
		{:else if isSignedIn}
			<Cloud class="size-4" />
		{:else}
			<CloudOff class="size-4 text-muted-foreground" />
		{/if}
	</Popover.Trigger>
	<Popover.Content class="w-80 p-0" align="end">
		{#if isSignedIn}
			<div class="p-4 space-y-3">
				<div class="space-y-1">
					<p class="text-sm font-medium">{currentUser?.name}</p>
					<p class="text-xs text-muted-foreground">{currentUser?.email}</p>
				</div>
				<div class="border-t pt-3">
					<Button
						variant="ghost"
						size="sm"
						class="w-full"
						onclick={async () => {
						await auth.signOut();
							popoverOpen = false;
						}}
					>
						<LogOut class="size-3.5" />
						Sign out
					</Button>
				</div>
			</div>
		{:else}
			<div class="flex items-center justify-center p-4"><AuthForm /></div>
		{/if}
	</Popover.Content>
</Popover.Root>
