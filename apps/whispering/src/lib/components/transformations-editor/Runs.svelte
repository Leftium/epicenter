<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Label } from '@epicenter/ui/label';
	import * as Table from '@epicenter/ui/table';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import PlayIcon from '@lucide/svelte/icons/play';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { format } from 'date-fns';
	import CopyablePre from '$lib/components/copyable/CopyablePre.svelte';
	import { report } from '$lib/report';
	import { transformationRuns } from '$lib/state/transformation-runs.svelte';
	import type { TransformationRun } from '$lib/workspace';

	let { runs }: { runs: TransformationRun[] } = $props();

	let expandedRunId = $state<string | null>(null);

	function toggleRunExpanded(runId: string) {
		expandedRunId = expandedRunId === runId ? null : runId;
	}

	function formatDate(dateStr: string) {
		return format(new Date(dateStr), 'MMM d, yyyy h:mm a');
	}

	/**
	 * Liveness is derived, never stored. A run with no result reads as running
	 * while its start is recent and interrupted once it goes quiet, so a crash
	 * mid-run self-heals instead of wedging at "running" forever. Generous
	 * window: a transformation may make an LLM call. See
	 * docs/articles/20260612T190745-liveness-belongs-to-the-process-not-the-row.md
	 */
	const RUNNING_GRACE_MS = 5 * 60 * 1000;

	type DerivedRunStatus = 'running' | 'interrupted' | 'completed' | 'failed';

	function deriveRunStatus(run: {
		startedAt: string;
		result: TransformationRun['result'];
	}): DerivedRunStatus {
		if (run.result) return run.result.status;
		const ageMs = Date.now() - new Date(run.startedAt).getTime();
		return ageMs < RUNNING_GRACE_MS ? 'running' : 'interrupted';
	}

	function statusBadgeVariant(status: DerivedRunStatus) {
		switch (status) {
			case 'completed':
				return 'status.completed' as const;
			case 'failed':
				return 'status.failed' as const;
			case 'running':
				return 'status.running' as const;
			case 'interrupted':
				return 'secondary' as const;
		}
	}
</script>

{#if runs.length === 0}
	<Empty.Root class="h-full">
		<Empty.Header>
			<Empty.Media variant="icon"> <PlayIcon /> </Empty.Media>
			<Empty.Title>No runs yet</Empty.Title>
			<Empty.Description>
				When you run a transformation, the results will appear here.
			</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<div class="space-y-4">
		<div class="flex justify-end px-2">
			<Button
				variant="destructive"
				size="sm"
				onclick={() => {
					confirmationDialog.open({
						title: 'Clear all transformation runs?',
						description: `This will permanently delete all ${runs.length} run${runs.length !== 1 ? 's' : ''} from this history. This action cannot be undone.`,
						confirm: { text: 'Delete All', variant: 'destructive' },
						onConfirm: () => {
							for (const run of runs) {
						transformationRuns.delete(run.id);
							}
							report.success({
								title: `${runs.length} run${runs.length !== 1 ? 's' : ''} deleted successfully`,
								description: 'All transformation runs have been deleted.',
							});
						},
					});
				}}
			>
				<Trash2 class="size-4" />
				Clear All Runs
			</Button>
		</div>
		<div class="h-full overflow-y-auto px-2">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Expand</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head>Started</Table.Head>
						<Table.Head>Completed</Table.Head>
						<Table.Head class="text-right">Actions</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each runs as run}
						{@const runStatus = deriveRunStatus(run)}
						<Table.Row>
							<Table.Cell>
								<Button
									variant="ghost"
									size="icon"
									class="size-8 shrink-0"
									onclick={() => toggleRunExpanded(run.id)}
								>
									{#if expandedRunId === run.id}
										<ChevronDown class="size-4" />
									{:else}
										<ChevronRight class="size-4" />
									{/if}
								</Button>
							</Table.Cell>
							<Table.Cell>
								<Badge variant={statusBadgeVariant(runStatus)}>
									{runStatus}
								</Badge>
							</Table.Cell>
							<Table.Cell> {formatDate(run.startedAt)} </Table.Cell>
							<Table.Cell>
								{run.result ? formatDate(run.result.completedAt) : '-'}
							</Table.Cell>
							<Table.Cell class="text-right">
								<Button
									variant="ghost"
									size="icon"
									tooltip="Delete run"
									onclick={() => {
										confirmationDialog.open({
											title: 'Delete transformation run?',
											description: `This will permanently delete the run from ${formatDate(run.startedAt)}. This action cannot be undone.`,
											confirm: { text: 'Delete', variant: 'destructive' },
										onConfirm: () => {
						transformationRuns.delete(run.id);
											report.success({
												title: 'Run deleted successfully',
												description:
													'Your transformation run has been deleted.',
											});
										},
										});
									}}
								>
									<Trash2 class="size-4" />
								</Button>
							</Table.Cell>
						</Table.Row>

						{#if expandedRunId === run.id}
							<Table.Row>
								<Table.Cell class="space-y-4 p-4" colspan={5}>
									<Label class="text-sm font-medium">Input</Label>
									<CopyablePre variant="text" copyableText={run.input} />

									{#if run.result?.status === 'completed'}
										<Label class="text-sm font-medium">Output</Label>
										<CopyablePre variant="text" copyableText={run.result.output} />
									{:else if run.result?.status === 'failed'}
										<Label class="text-sm font-medium">Error</Label>
										<CopyablePre variant="error" copyableText={run.result.error} />
									{/if}
								</Table.Cell>
							</Table.Row>
						{/if}
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	</div>
{/if}
