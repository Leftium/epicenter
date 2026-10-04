<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Link } from '@epicenter/ui/link';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Table from '@epicenter/ui/table';
	import { cn } from '@epicenter/ui/utils';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { resolve } from '$app/paths';
	import {
		captureDeletions,
		describeDeletions,
		nextSort,
		type RecordingSortKey,
		type RecordingStatus,
		removeCaptured,
		selectionIn,
		shownRows,
		STATUS_LABELS,
		toggleAllShown,
		toggleSelected,
		transcribeRows,
		transcriptExcerpt,
		transcriptsToCopy,
	} from '$lib/recording-collection.js';
	import { getSession } from '$lib/session.svelte.js';
	import { copyText, formatTime } from './file-actions.js';

	/**
	 * Every recording in the folder as one table: search, sort, tick, and act
	 * on several. The search text, the order, and the ticks are the session's,
	 * so they are as they were after a visit to another page. Activating a row
	 * opens that recording's details; ticking one does not.
	 */
	let { onOpen }: {
		/** A recording was opened from its row: show its details. */
		onOpen: () => void;
	} = $props();

	const { library, view } = getSession();

	const rows = $derived(shownRows(library, view.recordingQuery, view.recordingSort));
	const hidden = $derived(library.entries.length - rows.length);
	const selection = $derived(selectionIn(view.recordingSelected, rows, library));
	const selectedPaths = $derived(new Set(selection.rows.map((row) => row.path)));
	const allSelected = $derived(rows.length > 0 && selection.rows.length === rows.length);
	const busy = $derived(view.recordingBulk !== undefined);

	const columns: { key: RecordingSortKey; label: string; class?: string }[] = [
		{ key: 'title', label: 'Recording' },
		{ key: 'recordedAt', label: 'Recorded', class: 'hidden @2xl:table-cell' },
		{ key: 'durationMs', label: 'Length', class: 'hidden @xl:table-cell' },
		{ key: 'status', label: 'Status' },
	];

	const statusTone: Record<RecordingStatus, string> = {
		repair: 'text-destructive',
		failed: 'text-destructive',
		unsaved: 'text-destructive',
		transcribing: 'text-foreground',
		untranscribed: 'text-muted-foreground',
		transcribed: 'text-muted-foreground',
	};

	/** A length as minutes and seconds, or nothing when the file does not say. */
	function length(ms: number | undefined) {
		if (ms === undefined) return '';
		const seconds = Math.round(ms / 1000);
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	}

	async function openRow(path: string) {
		await library.open(path);
		onOpen();
	}

	const several = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	/** Up to a few reasons, so a long run still reads as one message. */
	const reasons = (items: readonly { title: string; reason: string }[]) =>
		items
			.slice(0, 4)
			.map(({ title, reason }) => `“${title}”: ${reason}`)
			.concat(items.length > 4 ? [`and ${items.length - 4} more`] : [])
			.join('\n');

	async function copySelected() {
		const { text, copied, without } = transcriptsToCopy(selection.rows);
		if (copied === 0) {
			toast.info('None of the selected recordings has a transcript to copy');
			return;
		}
		await copyText(
			text,
			`${several(copied, 'transcript', 'transcripts')}${without > 0 ? ` (${without} selected had none)` : ''}`,
		);
	}

	/** Sent only by this press: one request for each selected recording that has no transcript, one at a time. */
	async function transcribeSelected() {
		if (busy) return;
		const paths = selection.rows.map((row) => row.path);
		view.recordingBulk = { label: 'Transcribing', done: 0, total: paths.length };
		try {
			const outcome = await transcribeRows(library, paths, (done) => {
				view.recordingBulk = { label: 'Transcribing', done, total: paths.length };
			});
			const summary = [
				several(outcome.transcribed.length, 'recording transcribed', 'recordings transcribed'),
				...(outcome.failed.length > 0 ? [`${outcome.failed.length} failed`] : []),
				...(outcome.skipped.length > 0 ? [`${outcome.skipped.length} not sent`] : []),
			].join(', ');
			const description = reasons([...outcome.failed, ...outcome.skipped]) || undefined;
			if (outcome.failed.length > 0) toast.error(summary, { description });
			else if (outcome.transcribed.length === 0) toast.info(summary, { description });
			else toast.success(summary, { description });
		} finally {
			view.recordingBulk = undefined;
		}
	}

	/** Each deletion is captured first, as a single deletion is; the person confirms exactly those. */
	async function deleteSelected() {
		if (busy) return;
		const captured = await captureDeletions(
			library,
			selection.rows.map((row) => row.path),
		);
		if (captured.deletions.length === 0) {
			toast.error('None of the selected recordings can be deleted now', { description: reasons(captured.refused) });
			return;
		}
		confirmationDialog.open({
			...describeDeletions(captured),
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				view.recordingBulk = { label: 'Deleting', done: 0, total: captured.deletions.length };
				try {
					const { removed, problems } = await removeCaptured(library, captured.deletions);
					if (problems.length > 0)
						toast.error(`${several(removed, 'recording', 'recordings')} deleted, ${problems.length} not`, {
							description: reasons(problems),
						});
					else toast.success(`${several(removed, 'recording', 'recordings')} deleted`);
				} finally {
					view.recordingBulk = undefined;
				}
			},
		});
	}
</script>

<section class="@container flex h-full min-h-0 flex-col" aria-label="Recordings">
	<div class="flex flex-col gap-3 border-b px-3 py-3 sm:px-4">
		<div class="flex flex-wrap items-end gap-x-4 gap-y-2">
			<SectionHeader.Root class="min-w-0 flex-1">
				<SectionHeader.Title level={1} class="text-lg">Recordings</SectionHeader.Title>
				<SectionHeader.Description class="text-xs">
					{several(library.entries.length, 'recording', 'recordings')} in the folder{#if hidden > 0}, {hidden} hidden by the search{/if}
				</SectionHeader.Description>
			</SectionHeader.Root>
			<div class="relative w-full @xl:w-72">
				<SearchIcon class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
				<Input
					type="search"
					class="ps-8"
					bind:value={view.recordingQuery}
					placeholder="Search titles, notes, and transcripts"
					aria-label="Search recordings"
					autocomplete="off"
					data-testid="recording-filter"
				/>
			</div>
		</div>

		{#if selection.rows.length > 0 || selection.hidden > 0 || view.recordingBulk}
			<div class="flex flex-wrap items-center gap-2 text-sm" role="toolbar" aria-label="Selected recordings" data-testid="recording-selection">
				<span class="text-muted-foreground" role="status">
					{#if view.recordingBulk}
						<Spinner class="mr-1 inline size-3.5" />
						{view.recordingBulk.label} {view.recordingBulk.done} of {view.recordingBulk.total}…
					{:else if selection.rows.length > 0}
						<!-- Actions are on the ticked rows that are shown. What a search hides stays ticked and is left alone. -->
						{selection.rows.length} of the recordings shown {selection.rows.length === 1 ? 'is' : 'are'} selected{#if selection.hidden > 0}.
							{selection.hidden} more selected {selection.hidden === 1 ? 'is' : 'are'} hidden by the search and not included{/if}
					{:else}
						None of the recordings shown is selected. {selection.hidden} selected {selection.hidden === 1 ? 'is' : 'are'} hidden by the
						search; clear the search to act on {selection.hidden === 1 ? 'it' : 'them'}
					{/if}
				</span>
				<span class="ml-auto flex flex-wrap items-center gap-1.5">
					<Button
						size="sm"
						variant="outline"
						disabled={busy || selection.rows.length === 0}
						tooltip="Sends each selected recording shown here that has no transcript, one at a time, with {library.connections?.transcription?.model ?? 'the transcription connection in Settings'}"
						onclick={() => void transcribeSelected()}
						data-testid="transcribe-selected"
					>
						Transcribe {selection.rows.length}
					</Button>
					<Button size="sm" variant="outline" disabled={selection.rows.length === 0} onclick={() => void copySelected()} data-testid="copy-selected">
						Copy {selection.rows.length === 1 ? 'transcript' : 'transcripts'}
					</Button>
					<Button size="sm" variant="ghost-destructive" disabled={busy || selection.rows.length === 0} onclick={() => void deleteSelected()} data-testid="delete-selected">
						Delete {selection.rows.length}
					</Button>
					<Button
						size="sm"
						variant="ghost"
						tooltip="Clears every selected recording, including any the search hides"
						onclick={() => (view.recordingSelected = [])}
						data-testid="clear-selection"
					>
						Clear selection
					</Button>
				</span>
			</div>
		{/if}
	</div>

	{#if library.listError}
		<p class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive" role="status">
			Could not read the recordings folder: {library.listError}. Showing the last list that was read.
		</p>
	{/if}

	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if rows.length > 0}
			<Table.Root class="table-fixed" aria-label="Saved recordings" data-testid="recording-list">
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head class="w-9 ps-3 sm:ps-4">
							<Checkbox
								checked={allSelected}
								indeterminate={selection.rows.length > 0 && !allSelected}
								onCheckedChange={(checked) =>
									(view.recordingSelected = toggleAllShown(view.recordingSelected, rows, checked === true, library))}
								aria-label={allSelected ? 'Clear the selection of the recordings shown' : 'Select every recording shown'}
								data-testid="select-all"
							/>
						</Table.Head>
						{#each columns as column (column.key)}
							{@const sorted = view.recordingSort.key === column.key ? view.recordingSort.direction : undefined}
							<Table.Head
								class={cn(column.key === 'title' ? 'w-auto' : column.key === 'recordedAt' ? 'w-44' : column.key === 'durationMs' ? 'w-20' : 'w-40', column.class)}
								aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
							>
								<Button
									variant="ghost"
									size="sm"
									class="-ms-2.5 {sorted ? '' : 'text-muted-foreground'}"
									onclick={() => (view.recordingSort = nextSort(view.recordingSort, column.key))}
									data-testid="sort-{column.key}"
								>
									{column.label}
									{#if sorted === 'asc'}<ArrowUpIcon />{:else if sorted === 'desc'}<ArrowDownIcon />{/if}
								</Button>
							</Table.Head>
						{/each}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each rows as row (row.path)}
						{@const open = view.showingDetail && library.selectedPath === row.path}
						{@const excerpt = transcriptExcerpt(row, view.recordingQuery)}
						<!--
							The title is the row's button, so the keyboard reaches and opens a row the usual way.
							A click anywhere else on the row opens it too, except in the tick's own cell.
						-->
						<Table.Row
							class="cursor-pointer"
							data-state={selectedPaths.has(row.path) ? 'selected' : undefined}
							aria-current={open ? 'true' : undefined}
							onclick={() => void openRow(row.path)}
							data-testid="recording-row"
						>
							<Table.Cell class="ps-3 sm:ps-4" onclick={(event) => event.stopPropagation()}>
								<Checkbox
									checked={selectedPaths.has(row.path)}
									onCheckedChange={(checked) =>
										(view.recordingSelected = toggleSelected(view.recordingSelected, row.path, checked === true, library))}
									aria-label="Select {row.title}"
								/>
							</Table.Cell>
							<Table.Cell class="whitespace-normal">
								<div class="flex min-w-0 flex-col gap-0.5">
									<span class="flex min-w-0 items-center gap-2">
										<button
											type="button"
											class="min-w-0 truncate rounded-sm text-left font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 {open ? 'underline underline-offset-4' : ''}"
											data-recording={row.path}
											onclick={(event) => {
												event.stopPropagation();
												void openRow(row.path);
											}}
										>
											{row.title}
										</button>
										{#if row.entry.fields.capture === 'fixture'}<Badge variant="outline" class="shrink-0">Fixture</Badge>{/if}
									</span>
									<span class="truncate text-xs text-muted-foreground" data-testid="row-excerpt">
										{excerpt ?? 'No transcript yet'}
									</span>
								</div>
							</Table.Cell>
							<Table.Cell variant="muted" class={columns[1]?.class}>{formatTime(row.entry.fields.recordedAt, 'short')}</Table.Cell>
							<Table.Cell variant="muted" class={cn('tabular-nums', columns[2]?.class)}>{length(row.entry.fields.durationMs)}</Table.Cell>
							<Table.Cell class={cn('truncate', statusTone[row.status])} data-testid="row-status">
								{#if row.status === 'transcribing'}<Spinner class="mr-1 inline size-3.5" />{/if}
								{STATUS_LABELS[row.status]}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{:else}
			{@const searching = view.recordingQuery.trim() !== ''}
			<Empty.Root class="py-10">
				<Empty.Header>
					<Empty.Media variant="icon">
						{#if searching}<SearchIcon />{:else}<MicIcon />{/if}
					</Empty.Media>
					<Empty.Title>{searching ? 'No recordings match' : 'No recordings yet'}</Empty.Title>
					<Empty.Description>
						{#if searching}
							Nothing has “{view.recordingQuery.trim()}” in its title, notes, or transcripts.
						{:else}
							Record from <Link href={resolve('/')}>Home</Link>, or add
							<code class="font-mono">recordings/&lt;id&gt;.md</code> in the terminal.
						{/if}
					</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{/if}
	</div>

	{#if library.unreadable.length > 0}
		<div class="border-t bg-warning/10 px-3 py-2 text-xs">
			<p class="font-medium">Files that could not be read as text</p>
			<ul class="mt-1 space-y-0.5">
				{#each library.unreadable as item (item.path)}
					<li><code class="font-mono">{item.path}</code>: {item.message}</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>
