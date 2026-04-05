<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import * as Card from '@epicenter/ui/card';
	import { Progress } from '@epicenter/ui/progress';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import { createQuery } from '@tanstack/svelte-query';
	import { balanceQueryOptions } from '$lib/query/billing';

	const balance = createQuery(() => balanceQueryOptions());

	const creditBalance = $derived(balance.data?.balances?.ai_credits ?? null);
	const currentBalance = $derived(creditBalance?.balance ?? 0);
	const includedUsage = $derived(creditBalance?.included_usage ?? 0);
	const usagePercent = $derived(
		includedUsage > 0
			? Math.min(100, Math.round((currentBalance / includedUsage) * 100))
			: 0,
	);

	/** Find the monthly breakdown entry for the reset countdown. */
	const monthlyEntry = $derived(
		creditBalance?.breakdown?.find(
			(e: { interval?: string }) => e.interval === 'month',
		) ?? null,
	);
	const rolloverEntry = $derived(
		creditBalance?.breakdown?.find(
			(e: { interval?: string }) => e.interval === 'one_off',
		) ?? null,
	);

	const resetDate = $derived(
		monthlyEntry?.next_reset_at ? new Date(monthlyEntry.next_reset_at) : null,
	);
	const daysUntilReset = $derived(
		resetDate
			? Math.max(0, Math.ceil((resetDate.getTime() - Date.now()) / 86_400_000))
			: null,
	);
</script>

{#if balance.isPending}
	<Card.Root class="mb-8">
		<Card.Header> <Skeleton class="h-6 w-20" /> </Card.Header>
		<Card.Content>
			<Skeleton class="h-8 w-32 mb-3" />
			<Skeleton class="h-2 w-full" />
		</Card.Content>
	</Card.Root>
{:else if balance.isError}
	<Card.Root class="mb-8 border-destructive">
		<Card.Content class="pt-6">
			<p class="text-sm text-destructive">
				Failed to load balance. Try refreshing.
			</p>
		</Card.Content>
	</Card.Root>
{:else}
	<Card.Root class="mb-8">
		<Card.Header class="flex-row items-center justify-between space-y-0 pb-2">
			<Card.Title class="text-sm font-medium">Credits</Card.Title>
			{#if daysUntilReset !== null}
				<Badge variant="secondary" class="text-xs">
					Resets in {daysUntilReset} day{daysUntilReset === 1 ? '' : 's'}
				</Badge>
			{/if}
		</Card.Header>
		<Card.Content>
			<div class="flex items-baseline gap-2 mb-3">
				<span class="text-3xl font-bold tabular-nums">
					{currentBalance.toLocaleString()}
				</span>
				<span class="text-sm text-muted-foreground">
					of {includedUsage.toLocaleString()} included
				</span>
			</div>

			<Progress value={usagePercent} class="h-2 mb-3" />

			{#if rolloverEntry && rolloverEntry.balance > 0}
				<div class="flex gap-4 text-xs text-muted-foreground">
					<span>
						Monthly: {(monthlyEntry?.balance ?? 0).toLocaleString()}
					</span>
					<span> Rollover: {rolloverEntry.balance.toLocaleString()} </span>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
{/if}
