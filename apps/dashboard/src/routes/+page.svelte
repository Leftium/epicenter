<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Tabs from '@epicenter/ui/tabs';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { api, type AttachResponse } from '$lib/api';
	import CreditBalance from '$lib/components/CreditBalance.svelte';
	import UsageChart from '$lib/components/UsageChart.svelte';
	import TopModels from '$lib/components/TopModels.svelte';
	import ModelCostGuide from '$lib/components/ModelCostGuide.svelte';
	import ActivityFeed from '$lib/components/ActivityFeed.svelte';
	import PlanComparison from '$lib/components/PlanComparison.svelte';
	import { balanceQueryOptions } from '$lib/query/billing';
	import { queryClient } from '$lib/query/client';

	const balance = createQuery(() => balanceQueryOptions());
	const subscription = $derived(balance.data?.subscriptions?.find((s) => !s.addOn) ?? null);
	const isOnTrial = $derived(subscription?.trialEndsAt != null);

	async function openPortal() {
		try {
			const data = await api.billing.portal();
			if (data.url) window.location.href = data.url;
		} catch {
			toast.error('Could not open billing portal.');
		}
	}

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
</script>

<CreditBalance />

{#if isOnTrial}
	<Alert.Root class="mb-6">
		<Alert.Description class="flex items-center justify-between">
			<span>Add a payment method to keep Ultra after your trial ends.</span>
			<Button variant="link" size="sm" onclick={openPortal}>Update billing →</Button>
		</Alert.Description>
	</Alert.Root>
{/if}

<Tabs.Root value="overview">
	<Tabs.List>
		<Tabs.Trigger value="overview">Overview</Tabs.Trigger>
		<Tabs.Trigger value="models">Models</Tabs.Trigger>
		<Tabs.Trigger value="activity">Activity</Tabs.Trigger>
	</Tabs.List>

	<Tabs.Content value="overview" class="pt-6">
		<UsageChart />
		<TopModels />
	</Tabs.Content>

	<Tabs.Content value="models" class="pt-6">
		<ModelCostGuide />
	</Tabs.Content>

	<Tabs.Content value="activity" class="pt-6">
		<ActivityFeed />
	</Tabs.Content>
</Tabs.Root>

<PlanComparison />

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
	<Button variant="outline" onclick={openPortal}>Manage billing</Button>
</section>
