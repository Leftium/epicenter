<script lang="ts">
	import { Skeleton } from '@epicenter/ui/skeleton';
	import * as Table from '@epicenter/ui/table';
	import { createQuery } from '@tanstack/svelte-query';
	import { eventsQueryOptions } from '$lib/query/billing';

	const events = createQuery(() => eventsQueryOptions({ limit: 50 }));

	function formatTimestamp(ts: number | string): string {
		const date = new Date(typeof ts === 'number' ? ts : ts);
		return date.toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		});
	}
</script>

{#if events.isPending}
	<div class="space-y-2">
		{#each Array(10) as _}
			<Skeleton class="h-8 w-full" />
		{/each}
	</div>
{:else if events.isError}
	<p class="text-sm text-destructive">Failed to load activity.</p>
{:else if !events.data?.list?.length}
	<p class="text-sm text-muted-foreground py-8 text-center">No activity yet.</p>
{:else}
	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head>Time</Table.Head>
				<Table.Head>Model</Table.Head>
				<Table.Head>Provider</Table.Head>
				<Table.Head class="text-right">Credits</Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each events.data.list as event}
				<Table.Row>
					<Table.Cell class="text-xs text-muted-foreground whitespace-nowrap">
						{formatTimestamp(event.timestamp ?? event.created_at ?? '')}
					</Table.Cell>
					<Table.Cell class="font-mono text-xs">
						{event.properties?.model ?? '—'}
					</Table.Cell>
					<Table.Cell class="text-xs text-muted-foreground">
						{event.properties?.provider ?? '—'}
					</Table.Cell>
					<Table.Cell class="text-right tabular-nums">
						{event.value ?? 1}
					</Table.Cell>
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
{/if}
