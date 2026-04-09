<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import {
		CommandPalette,
		type CommandPaletteItem,
	} from '@epicenter/ui/command-palette';
	import * as Resizable from '@epicenter/ui/resizable';
	import type { DocumentHandle } from '@epicenter/workspace';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import TableIcon from '@lucide/svelte/icons/table-2';
	import type * as Y from 'yjs';
	import { workspace } from '$lib/client';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import EntriesTable from '$lib/components/EntriesTable.svelte';
	import EntryEditor from '$lib/components/EntryEditor.svelte';
	import EntryTimeline from '$lib/components/EntryTimeline.svelte';
	import EntriesSidebar from '$lib/components/EntriesSidebar.svelte';
	import { Kbd } from '@epicenter/ui/kbd';
	import { entriesState } from '$lib/state/entries-state.svelte';
	import { viewState } from '$lib/state/view-state.svelte';

	// ─── Command Palette ─────────────────────────────────────────────────────────

	let paletteOpen = $state(false);
	let paletteQuery = $state('');

	const paletteItems = $derived.by((): CommandPaletteItem[] => {
		if (!paletteOpen) return [];
		return entriesState.activeEntries.map((entry) => ({
			id: entry.id,
			label: entry.title || 'Untitled',
			description: entry.subtitle || undefined,
			icon: FileTextIcon,
			keywords: [...entry.tags, ...entry.type],
			group: entry.type.length > 0 ? entry.type[0] : 'Uncategorized',
			onSelect: () => viewState.selectEntry(entry.id),
		}));
	});

	// ─── Document Handle (Y.Text) ────────────────────────────────────────────────

	let currentYText = $state<Y.Text | null>(null);
	let currentDocHandle = $state<DocumentHandle | null>(null);

	const selectedEntry = $derived(
		viewState.selectedEntryId
			? (entriesState.entriesMap.get(viewState.selectedEntryId) ?? null)
			: null,
	);

	/** Entries filtered by sidebar type/tag filters. */
	const filteredEntries = $derived.by(() => {
		let result = entriesState.activeEntries;
		const typeFilter = viewState.activeTypeFilter;
		const tagFilter = viewState.activeTagFilter;
		if (typeFilter) {
			result = result.filter((e) => e.type.includes(typeFilter));
		}
		if (tagFilter) {
			result = result.filter((e) => e.tags.includes(tagFilter));
		}
		return result;
	});

	/** Create a new entry and select it for editing. */
	function createEntry() {
		const { id } = workspace.actions.entries.create({});
		viewState.selectEntry(id);
	}

	$effect(() => {
		const entryId = viewState.selectedEntryId;
		if (!entryId) {
			currentYText = null;
			currentDocHandle = null;
			return;
		}

		let cancelled = false;
		workspace.documents.entries.content.open(entryId).then((handle) => {
			if (cancelled) return;
			currentDocHandle = handle;
			currentYText = handle.asText();
		});

		return () => {
			cancelled = true;
			if (currentDocHandle) {
				workspace.documents.entries.content.close(entryId);
			}
			currentYText = null;
			currentDocHandle = null;
		};
	});
</script>

<svelte:window
	onkeydown={(event) => {
	const isInputFocused =
		event.target instanceof HTMLInputElement ||
		event.target instanceof HTMLTextAreaElement ||
		(event.target instanceof HTMLElement && event.target.isContentEditable);

	if (event.key === 'k' && event.metaKey) {
		event.preventDefault();
		paletteOpen = !paletteOpen;
		return;
	}

	if (event.key === 'n' && event.metaKey) {
		event.preventDefault();
		createEntry();
		return;
	}

	if (event.key === 'Escape' && !isInputFocused && viewState.selectedEntryId) {
		event.preventDefault();
		viewState.selectEntry(null);
	}
}}
/>

<div class="flex h-screen flex-col">
	<AppHeader
		onOpenSearch={() => (paletteOpen = true)}
		onCreateEntry={() => createEntry()}
	/>
	<Resizable.PaneGroup direction="horizontal" class="flex-1">
		<Resizable.Pane defaultSize={20} minSize={15} maxSize={40}>
			<EntriesSidebar entries={entriesState.activeEntries} />
		</Resizable.Pane>
		<Resizable.Handle withHandle />
		<Resizable.Pane defaultSize={80}>
			<main class="flex h-full flex-1 flex-col overflow-hidden">
				{#if selectedEntry && currentYText}
					{#key viewState.selectedEntryId}
						<EntryEditor
							entry={selectedEntry}
							ytext={currentYText}
							onUpdate={(updates) => {
								if (!viewState.selectedEntryId) return;
							workspace.tables.entries.update(viewState.selectedEntryId, updates);
							}}
							onBack={() => viewState.selectEntry(null)}
						/>
					{/key}
				{:else if selectedEntry}
					<div class="flex h-full items-center justify-center">
						<p class="text-muted-foreground">Loading editor…</p>
					</div>
				{:else}
					<!-- View mode toggle header -->
					<div class="flex items-center justify-end border-b px-4 py-2">
						<Button
							variant="ghost"
							size="icon"
							class="size-7"
							onclick={() => viewState.toggleViewMode()}
							title={viewState.viewMode === 'table' ? 'Switch to timeline' : 'Switch to table'}
						>
							{#if viewState.viewMode === 'table'}
								<ClockIcon class="size-4" />
							{:else}
								<TableIcon class="size-4" />
							{/if}
						</Button>
					</div>

					{#if viewState.viewMode === 'table'}
						<EntriesTable
							entries={filteredEntries}
							searchQuery={viewState.searchQuery}
							sortBy={viewState.sortBy}
							selectedEntryId={viewState.selectedEntryId}
							onSelectEntry={(id) => viewState.selectEntry(id)}
							onAddEntry={() => createEntry()}
							onSortChange={(sort) => (viewState.sortBy = sort)}
						/>
					{:else}
						<EntryTimeline
							entries={filteredEntries}
							sortBy={viewState.sortBy}
							selectedEntryId={viewState.selectedEntryId}
							onSelectEntry={(id) => viewState.selectEntry(id)}
							onAddEntry={() => createEntry()}
						/>
					{/if}
				{/if}
			</main>
		</Resizable.Pane>
	</Resizable.PaneGroup>
	<div class="flex h-6 shrink-0 items-center gap-3 border-t bg-background px-3 text-xs text-muted-foreground">
		<span>{entriesState.activeEntries.length} {entriesState.activeEntries.length === 1 ? 'entry' : 'entries'}</span>
		<div class="ml-auto flex items-center gap-1.5">
			<span class="flex items-center gap-1">
				Search <Kbd>⌘K</Kbd>
			</span>
		</div>
	</div>
</div>

<CommandPalette
	items={paletteItems}
	bind:open={paletteOpen}
	bind:value={paletteQuery}
	placeholder="Search entries…"
	emptyMessage="No entries found."
	title="Search Entries"
	description="Search entries by title, subtitle, tags, or type"
/>
