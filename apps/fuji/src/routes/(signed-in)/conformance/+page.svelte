<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import * as Table from '@epicenter/ui/table';
	import { type TableParseError } from '@epicenter/workspace';
	import ArrowUpCircleIcon from '@lucide/svelte/icons/arrow-up-circle';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import LockIcon from '@lucide/svelte/icons/lock';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import XIcon from '@lucide/svelte/icons/x';
	import { requireFuji } from '$lib/session';
	import { asEntryId } from '$lib/workspace';

	const fuji = requireFuji();

	const entries = $derived(fuji.entries);

	const causeLabel = {
		ValidationFailed: 'Does not match the schema',
		MigrationFailed: 'Migration failed',
		UnknownVersion: 'Unrecognized version stamp',
	} satisfies Record<TableParseError['name'], string>;

	function discard(error: TableParseError) {
		confirmationDialog.open({
			title: 'Discard this entry?',
			description: `Entry "${error.id}" will be permanently removed. This cannot be undone.`,
			confirm: { text: 'Discard', variant: 'destructive' },
			onConfirm: () => {
				fuji.tables.entries.delete(asEntryId(error.id));
			},
		});
	}
</script>

<main class="flex h-full flex-1 flex-col overflow-hidden">
	<div class="flex items-center justify-between border-b px-4 py-2">
		<h2 class="text-sm font-semibold">Needs Attention</h2>
		<span class="text-xs text-muted-foreground">
			{entries.conforming} entries match the current schema
		</span>
	</div>

	{#if entries.nonconforming.length === 0 && entries.newerWriter.length === 0 && entries.unreadable.length === 0}
		<Empty.Root class="flex-1">
			<Empty.Media>
				<CircleCheckIcon class="size-8 text-muted-foreground" />
			</Empty.Media>
			<Empty.Title>Every entry matches the schema</Empty.Title>
			<Empty.Description>
				Entries that fail the schema, come from a newer Fuji, or are encrypted
				with a key this device does not have will appear here.
			</Empty.Description>
		</Empty.Root>
	{:else}
		<div class="flex-1 space-y-4 overflow-auto p-4">
			{#if entries.newerWriter.length > 0}
				<Alert.Root variant="warning">
					<ArrowUpCircleIcon class="size-4" />
					<Alert.Title>
						{entries.newerWriter.length}
						{entries.newerWriter.length === 1 ? 'entry was' : 'entries were'}
						written by a newer version of Fuji
					</Alert.Title>
					<Alert.Description>
						Update this app to read or edit them. They stay synced and
						untouched; editing here is refused so the newer fields survive.
					</Alert.Description>
				</Alert.Root>
			{/if}

			{#if entries.unreadable.length > 0}
				<Alert.Root variant="warning">
					<LockIcon class="size-4" />
					<Alert.Title>
						{entries.unreadable.length}
						{entries.unreadable.length === 1 ? 'entry is' : 'entries are'}
						encrypted with a key this device does not have
					</Alert.Title>
					<Alert.Description>
						Another device wrote them after a key change. Open Fuji where the
						key lives to read them. They stay synced and untouched.
					</Alert.Description>
				</Alert.Root>

				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Entry</Table.Head>
							<Table.Head>Reason</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each entries.unreadable as error (error.id)}
							<Table.Row>
								<Table.Cell class="font-mono text-xs">{error.id}</Table.Cell>
								<Table.Cell class="text-muted-foreground">
									{error.reason}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}

			{#if entries.nonconforming.length > 0}
				<Alert.Root variant="warning">
					<TriangleAlertIcon class="size-4" />
					<Alert.Title>
						{entries.nonconforming.length}
						{entries.nonconforming.length === 1
							? 'entry does'
							: 'entries do'}
						not match the current schema
					</Alert.Title>
					<Alert.Description>
						The data is intact but kept out of your lists because it does not
						match the current schema. It stays stored and untouched; discard
						removes the entry permanently.
					</Alert.Description>
				</Alert.Root>

				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Entry</Table.Head>
							<Table.Head>Cause</Table.Head>
							<Table.Head>Details</Table.Head>
							<Table.Head class="w-[100px]"></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each entries.nonconforming as error (error.id)}
							<Table.Row>
								<Table.Cell class="font-mono text-xs">{error.id}</Table.Cell>
								<Table.Cell>{causeLabel[error.name]}</Table.Cell>
								<Table.Cell class="max-w-md truncate text-muted-foreground">
									{error.message}
								</Table.Cell>
								<Table.Cell>
									<div class="flex justify-end">
										<Button
											variant="ghost-destructive"
											size="icon-sm"
											title="Discard entry"
											onclick={() => discard(error)}
										>
											<XIcon class="size-4" />
										</Button>
									</div>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}

			{#if entries.newerWriter.length > 0}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Entry</Table.Head>
							<Table.Head>Written by</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each entries.newerWriter as error (error.id)}
							<Table.Row>
								<Table.Cell class="font-mono text-xs">{error.id}</Table.Cell>
								<Table.Cell class="text-muted-foreground">
									Schema version {error.version}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</div>
	{/if}
</main>
