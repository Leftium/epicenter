<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Alert from '@epicenter/ui/alert';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { api, type AttachResponse, type PortalResponse } from '$lib/api';
	import { queryClient } from '$lib/query/client';
	import { balanceQueryOptions } from '$lib/query/billing';

	const topUp = createMutation(() => ({
		mutationFn: () => api.billing.topUp(window.location.href),
		onSuccess: (result: AttachResponse) => {
			if (result.paymentUrl) {
				window.location.href = result.paymentUrl;
			} else {
				toast.success('Credits added to your account');
				queryClient.invalidateQueries({ queryKey: ['billing'] });
			}
		},
		onError: () => {
			toast.error('Top-up failed. Please try again.');
		},
	}));

	async function openPortal() {
		try {
			const data = await api.billing.portal();
			if (data.url) window.location.href = data.url;
		} catch {
			toast.error('Could not open billing portal.');
		}
	}

	const balance = createQuery(() => balanceQueryOptions());
	const subscription = $derived(balance.data?.subscriptions?.find((s) => !s.addOn) ?? null);
	const isOnTrial = $derived(subscription?.trialEndsAt != null);
</script>

{#if isOnTrial}
	<Alert.Root class="mb-3">
		<Alert.Description>
			Add a payment method to keep Ultra after your trial ends.
			<button
				class="ml-1 underline underline-offset-2 hover:text-foreground transition-colors"
				onclick={openPortal}
			>
				Update billing →
			</button>
		</Alert.Description>
	</Alert.Root>
{/if}

<section class="flex flex-wrap gap-3">
	<Button
		variant="outline"
		onclick={() => topUp.mutate()}
		disabled={topUp.isPending}
	>
		{#if topUp.isPending}
			<Spinner class="size-3.5" />
		{:else}
			Buy 500 credits — $5
		{/if}
	</Button>

	<Button variant="outline" onclick={openPortal}> Manage billing </Button>
</section>
