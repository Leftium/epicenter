<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import type { Snippet } from 'svelte';
	import { migrationDialog } from './migration-dialog.svelte';
	import { MOCK_RECORDING_COUNT, MOCK_TRANSFORMATION_COUNT } from './migration-test-data';

	let { trigger }: { trigger?: Snippet<[{ props: Record<string, unknown> }]> } = $props();

	let logsContainer = $state<HTMLDivElement | null>(null);

	// Auto-scroll logs to bottom
	$effect(() => {
		if (logsContainer && migrationDialog.logs.length > 0) {
			logsContainer.scrollTop = logsContainer.scrollHeight;
		}
	});
</script>

<Dialog.Root bind:open={migrationDialog.isOpen}>
	{#if trigger}
		<Dialog.Trigger>
			{#snippet child({ props })}
				{@render trigger({ props })}
			{/snippet}
		</Dialog.Trigger>
	{/if}
	<Dialog.Content class="max-h-[90vh] max-w-2xl overflow-y-auto">
		<Dialog.Header>
			<Dialog.Title>Database Migration</Dialog.Title>
			<Dialog.Description>
				Migrate your recordings and transformations to the new workspace format.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4">
			{#if migrationDialog.isPending}
				<Button
					onclick={migrationDialog.startWorkspaceMigration}
					disabled={migrationDialog.isRunning}
					class="w-full"
				>
					{migrationDialog.isRunning ? 'Migrating…' : 'Start Migration'}
				</Button>
			{:else}
				<p class="text-sm text-muted-foreground">
					Migration is already complete.
				</p>
			{/if}

			{#if migrationDialog.logs.length > 0}
				<div class="space-y-2">
					<h3 class="text-sm font-semibold">Progress</h3>
					<div
						bind:this={logsContainer}
						class="max-h-48 overflow-y-auto rounded-lg border bg-muted p-3 font-mono text-xs"
					>
						{#each migrationDialog.logs as log}
							<div class="mb-1">{log}</div>
						{/each}
					</div>
				</div>
			{/if}

			{#if migrationDialog.migrationResult}
				{@const r = migrationDialog.migrationResult}
				<div class="rounded-lg border p-4">
					<h3 class="mb-3 text-sm font-semibold">Results</h3>
					<div class="space-y-1 text-sm text-muted-foreground">
						<p>
							Recordings: {r.recordings.migrated} migrated,
							{r.recordings.skipped}
							skipped, {r.recordings.failed} failed (of {r.recordings.total})
						</p>
						<p>
							Transformations: {r.transformations.migrated} migrated,
							{r.transformations.skipped}
							skipped, {r.transformations.failed}
							failed (of {r.transformations.total})
						</p>
						<p>
							Steps: {r.steps.migrated} migrated, {r.steps.skipped} skipped,
							{r.steps.failed}
							failed (of {r.steps.total})
						</p>
					</div>
				</div>
			{/if}

			{#if import.meta.env.DEV}
				<div class="rounded-lg border border-dashed p-4">
					<h3 class="mb-3 text-sm font-semibold">Dev Tools</h3>
					<div class="space-y-3">
						<div>
							<p class="mb-1.5 text-xs text-muted-foreground">Seed & Clear</p>
							<div class="flex flex-wrap gap-2">
								<Button
									onclick={migrationDialog.seedIndexedDB}
									disabled={migrationDialog.isDevBusy}
									variant="outline"
									size="sm"
								>
									{migrationDialog.isSeeding
										? 'Seeding\u2026'
										: `Seed ${MOCK_RECORDING_COUNT} Recordings + ${MOCK_TRANSFORMATION_COUNT} Transformations`}
								</Button>
								<Button
									onclick={migrationDialog.clearIndexedDB}
									disabled={migrationDialog.isDevBusy}
									variant="outline"
									size="sm"
								>
									{migrationDialog.isClearing ? 'Clearing\u2026' : 'Clear IndexedDB'}
								</Button>
							</div>
						</div>
						<div>
							<p class="mb-1.5 text-xs text-muted-foreground">Reset</p>
							<Button
								onclick={migrationDialog.resetMigration}
								disabled={migrationDialog.isDevBusy}
								variant="outline"
								size="sm"
							>
								{migrationDialog.isResetting
									? 'Resetting\u2026'
									: 'Reset Migration State'}
							</Button>
							<p class="mt-1 text-xs text-muted-foreground">
								Clears workspace tables and resets localStorage\u2014re-enables the migration button.
							</p>
						</div>
					</div>
				</div>
			{/if}
		</div>

		<Dialog.Footer>
			<Button
				onclick={() => (migrationDialog.isOpen = false)}
				variant="outline"
			>
				Close
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
