<script lang="ts">
	import * as Card from '@epicenter/ui/card';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import * as Table from '@epicenter/ui/table';
	import { createQuery } from '@tanstack/svelte-query';
	import { usageQueryOptions } from '$lib/query/billing';

	const usage = createQuery(() =>
		usageQueryOptions({
			range: '30d',
			binSize: 'day',
			groupBy: 'properties.model',
		}),
	);

	/**
	 * Aggregate per-model totals across all time periods.
	 * Returns sorted array of [model, totalCredits] pairs.
	 */
	const modelTotals = $derived(
		(usage.data?.list ?? []).reduce(
			(
				acc: Record<string, number>,
				period: { grouped_values?: { ai_usage?: Record<string, number> } },
			) => {
				for (const [model, count] of Object.entries(
					period.grouped_values?.ai_usage ?? {},
				)) {
					acc[model] = (acc[model] ?? 0) + count;
				}
				return acc;
			},
			{} as Record<string, number>,
		),
	);

	const sortedModels = $derived(
		Object.entries(modelTotals)
			.sort(([, a], [, b]) => b - a)
			.slice(0, 10),
	);
</script>

<Card.Root class="mb-6">
	<Card.Header>
		<Card.Title class="text-sm font-medium">Top Models (30d)</Card.Title>
	</Card.Header>
	<Card.Content>
		{#if usage.isPending}
			<div class="space-y-2">
				{#each Array(5) as _}
					<Skeleton class="h-8 w-full" />
				{/each}
			</div>
		{:else if usage.isError}
			<p class="text-sm text-destructive">Failed to load model data.</p>
		{:else if sortedModels.length === 0}
			<p class="text-sm text-muted-foreground py-4 text-center">
				No usage data yet.
			</p>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Model</Table.Head>
						<Table.Head class="text-right">Credits</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each sortedModels as [ model, credits ]}
						<Table.Row>
							<Table.Cell class="font-mono text-xs">{model}</Table.Cell>
							<Table.Cell class="text-right tabular-nums">
								{credits.toLocaleString()}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Card.Content>
</Card.Root>
