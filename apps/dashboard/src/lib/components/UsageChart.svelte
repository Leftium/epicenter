<script lang="ts">
	import * as Card from '@epicenter/ui/card';
	import * as Select from '@epicenter/ui/select';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import { createQuery } from '@tanstack/svelte-query';
	import { usageQueryOptions } from '$lib/query/billing';

	type Range = '7d' | '30d' | '90d';

	let selectedRange = $state<Range>('30d');

	const usage = createQuery(() =>
		usageQueryOptions({
			range: selectedRange,
			binSize: selectedRange === '7d' ? 'hour' : 'day',
			groupBy: 'properties.model',
			maxGroups: 8,
		}),
	);

	const rangeOptions = [
		{ value: '7d' as const, label: '7 days' },
		{ value: '30d' as const, label: '30 days' },
		{ value: '90d' as const, label: '90 days' },
	];

	const totalCredits = $derived(usage.data?.total?.ai_usage?.sum ?? 0);
</script>

<Card.Root class="mb-6">
	<Card.Header class="flex-row items-center justify-between space-y-0 pb-2">
		<Card.Title class="text-sm font-medium">Usage</Card.Title>
		<Select.Root
			type="single"
			value={selectedRange}
			onValueChange={(v) => { if (v) selectedRange = v as Range; }}
		>
			<Select.Trigger class="w-[120px] h-8 text-xs">
				{rangeOptions.find((o) => o.value === selectedRange)?.label}
			</Select.Trigger>
			<Select.Content>
				{#each rangeOptions as opt (opt.value)}
					<Select.Item value={opt.value}>{opt.label}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</Card.Header>
	<Card.Content>
		{#if usage.isPending}
			<Skeleton class="h-48 w-full" />
		{:else if usage.isError}
			<p class="text-sm text-destructive py-12 text-center">
				Failed to load usage data.
			</p>
		{:else}
			<div class="h-48 flex items-end gap-1">
				{#each usage.data?.list ?? [] as period}
					{@const value = period.values?.ai_usage ?? 0}
					{@const maxValue = Math.max(...(usage.data?.list ?? []).map((p: { values?: { ai_usage?: number } }) => p.values?.ai_usage ?? 0), 1)}
					<div
						class="flex-1 bg-primary/20 hover:bg-primary/30 rounded-t transition-colors relative group"
						style="height: {Math.max(2, (value / maxValue) * 100)}%"
					>
						<div
							class="absolute -top-6 left-1/2 -translate-x-1/2 bg-popover text-popover-foreground text-xs px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none"
						>
							{value.toLocaleString()}
							credits
						</div>
					</div>
				{/each}
			</div>

			<div
				class="mt-4 flex items-center justify-between text-xs text-muted-foreground"
			>
				<span>Total: {totalCredits.toLocaleString()} credits</span>
				{#if usage.data?.total?.ai_usage?.count}
					<span
						>{usage.data.total.ai_usage.count.toLocaleString()}
						requests</span
					>
				{/if}
			</div>

			{#if usage.data?.list?.[0]?.grouped_values?.ai_usage}
				{@const models = Object.entries(usage.data.list.reduce(
					(acc: Record<string, number>, period: { grouped_values?: { ai_usage?: Record<string, number> } }) => {
						for (const [model, count] of Object.entries(period.grouped_values?.ai_usage ?? {})) {
							acc[model] = (acc[model] ?? 0) + count;
						}
						return acc;
					},
					{} as Record<string, number>,
				)).sort(([, a], [, b]) => b - a).slice(0, 5)}

				<div class="mt-3 flex flex-wrap gap-2">
					{#each models as [ model, count ]}
						<span
							class="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"
						>
							{model}
							<span class="text-muted-foreground"
								>{count.toLocaleString()}</span
							>
						</span>
					{/each}
				</div>
			{/if}
		{/if}
	</Card.Content>
</Card.Root>
