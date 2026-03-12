<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import * as ScrollArea from '@epicenter/ui/scroll-area';
	import { Button } from '@epicenter/ui/button';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PinIcon from '@lucide/svelte/icons/pin';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { isToday, isYesterday, format } from 'date-fns';
	import workspaceClient, { type Entry, type EntryId } from '$lib/workspace';
	import { dateTimeStringNow, generateId } from '@epicenter/workspace';
	import type { DocumentHandle } from '@epicenter/workspace';
	import type * as Y from 'yjs';
	import FujiEditor from '$lib/components/editor.svelte';

	let entries = $state<Entry[]>([]);
	let selectedEntryId = $state<EntryId | null>(null);
	let currentYText = $state<Y.Text | null>(null);
	let currentDocHandle = $state<DocumentHandle | null>(null);

	$effect(() => {
		entries = workspaceClient.tables.entries.getAllValid();
		const result = workspaceClient.kv.get('selectedEntryId');
		selectedEntryId = result.status === 'valid' ? result.value : null;

		const unsubscribe = workspaceClient.tables.entries.observe(() => {
			entries = workspaceClient.tables.entries.getAllValid();
		});

		const unsubscribeKv = workspaceClient.kv.observe('selectedEntryId', (change) => {
			if (change.type === 'set') {
				selectedEntryId = change.value;
			} else {
				selectedEntryId = null;
			}
		});

		return () => {
			unsubscribe();
			unsubscribeKv();
		};
	});

	const selectedEntry = $derived(entries.find((e) => e.id === selectedEntryId) ?? null);

	// Open/close the Y.Text document when the selected entry changes
	$effect(() => {
		const entryId = selectedEntryId;
		if (!entryId) {
			currentYText = null;
			currentDocHandle = null;
			return;
		}

		let cancelled = false;
		workspaceClient.documents.entries.body.open(entryId).then((handle) => {
			if (cancelled) return;
			currentDocHandle = handle;
			currentYText = handle.ydoc.getText('content');
		});

		return () => {
			cancelled = true;
			if (currentDocHandle) {
				workspaceClient.documents.entries.body.close(entryId);
			}
			currentYText = null;
			currentDocHandle = null;
		};
	});

	function parseDateTime(dts: string): Date {
		return new Date(dts.split('|')[0]!);
	}

	function getDateLabel(dts: string): string {
		const date = parseDateTime(dts);
		if (isToday(date)) return 'Today';
		if (isYesterday(date)) return 'Yesterday';
		return format(date, 'MMMM d');
	}

	const groupedEntries = $derived.by(() => {
		const pinned = entries
			.filter((e) => e.pinned)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

		const unpinned = entries
			.filter((e) => !e.pinned)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

		const groups: { label: string; entries: Entry[] }[] = [];

		if (pinned.length > 0) {
			groups.push({ label: 'Pinned', entries: pinned });
		}

		let currentLabel = '';
		let currentGroup: Entry[] = [];

		for (const entry of unpinned) {
			const label = getDateLabel(entry.updatedAt);
			if (label !== currentLabel) {
				if (currentGroup.length > 0) {
					groups.push({ label: currentLabel, entries: currentGroup });
				}
				currentLabel = label;
				currentGroup = [entry];
			} else {
				currentGroup.push(entry);
			}
		}

		if (currentGroup.length > 0) {
			groups.push({ label: currentLabel, entries: currentGroup });
		}

		return groups;
	});
</script>

<div class="flex h-screen w-full overflow-hidden bg-background">
	<Resizable.PaneGroup direction="horizontal">
		<Resizable.Pane defaultSize={30} minSize={20} class="flex flex-col border-r">
			<div class="flex items-center justify-between border-b p-4">
				<h1 class="text-lg font-semibold">Fuji</h1>
				<Button
					variant="ghost"
					size="icon"
					onclick={() => {
						const id = generateId() as unknown as EntryId;
						workspaceClient.tables.entries.set({
							id,
							title: '',
							preview: '',
							pinned: false,
							createdAt: dateTimeStringNow(),
							updatedAt: dateTimeStringNow(),
							_v: 1,
						});
						workspaceClient.kv.set('selectedEntryId', id);
					}}
				>
					<PlusIcon class="size-4" />
				</Button>
			</div>
			<ScrollArea.Root class="flex-1">
				{#if entries.length === 0}
					<div class="flex h-full items-center justify-center p-8 text-center text-muted-foreground">
						<p>No entries yet. Click + to create one.</p>
					</div>
				{:else}
					<div class="flex flex-col gap-4 p-4">
						{#each groupedEntries as group}
							<div class="flex flex-col gap-1">
								<h2 class="px-2 text-xs font-medium text-muted-foreground">
									{group.label}
								</h2>
								{#each group.entries as entry (entry.id)}
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										class="group relative flex cursor-pointer flex-col gap-1 rounded-lg p-3 text-sm transition-colors hover:bg-accent/50 {selectedEntryId === entry.id ? 'bg-accent' : ''}"
										onclick={() => workspaceClient.kv.set('selectedEntryId', entry.id)}
									>
										<div class="flex items-start justify-between gap-2">
											<span class="font-medium line-clamp-1">
												{entry.title || 'Untitled'}
											</span>
											<span class="shrink-0 text-xs text-muted-foreground">
												{format(parseDateTime(entry.updatedAt), 'h:mm a')}
											</span>
										</div>
										<p class="line-clamp-2 text-xs text-muted-foreground">
											{entry.preview || 'No content'}
										</p>
										
										<div class="absolute right-2 top-2 hidden items-center gap-1 group-hover:flex {selectedEntryId === entry.id ? 'flex' : ''}">
											<Button
												variant="ghost"
												size="icon"
												class="size-6 h-6 w-6"
												onclick={(e) => {
													e.stopPropagation();
													workspaceClient.tables.entries.update(entry.id, {
														pinned: !entry.pinned,
													});
												}}
											>
												<PinIcon class="size-3 {entry.pinned ? 'fill-current' : ''}" />
											</Button>
											<Button
												variant="ghost"
												size="icon"
												class="size-6 h-6 w-6 text-destructive hover:text-destructive"
												onclick={(e) => {
													e.stopPropagation();
													workspaceClient.tables.entries.delete(entry.id);
													if (selectedEntryId === entry.id) {
														workspaceClient.kv.set('selectedEntryId', null);
													}
												}}
											>
												<TrashIcon class="size-3" />
											</Button>
										</div>
									</div>
								{/each}
							</div>
						{/each}
					</div>
				{/if}
			</ScrollArea.Root>
		</Resizable.Pane>
		<Resizable.Handle withHandle />
		<Resizable.Pane defaultSize={70} minSize={30} class="flex flex-col">
			{#if selectedEntry && currentYText}
				{#key selectedEntryId}
					<FujiEditor
						ytext={currentYText}
						onContentChange={({ title, preview }) => {
							if (!selectedEntryId) return;
							workspaceClient.tables.entries.update(selectedEntryId, {
								title,
								preview,
							});
						}}
					/>
				{/key}
			{:else if selectedEntry}
				<div class="flex h-full items-center justify-center">
					<p class="text-muted-foreground">Loading editor…</p>
				</div>
			{:else}
				<div class="flex h-full items-center justify-center">
					<p class="text-muted-foreground">Select or create an entry</p>
				</div>
			{/if}
		</Resizable.Pane>
	</Resizable.PaneGroup>
</div>
