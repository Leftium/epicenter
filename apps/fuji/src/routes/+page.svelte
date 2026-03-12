<script lang="ts">
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import type { DocumentHandle } from '@epicenter/workspace';
	import { dateTimeStringNow, generateId } from '@epicenter/workspace';
	import type * as Y from 'yjs';
	import FujiSidebar from '$lib/components/FujiSidebar.svelte';
	import EntriesTable from '$lib/components/EntriesTable.svelte';
	import workspaceClient, { type Entry, type EntryId } from '$lib/workspace';

	// ─── Reactive State ────────────────────────────────────────────────────────────

	let entries = $state<Entry[]>([]);
	let selectedEntryId = $state<EntryId | null>(null);
	let currentYText = $state<Y.Text | null>(null);
	let currentDocHandle = $state<DocumentHandle | null>(null);

	// ─── Filters ─────────────────────────────────────────────────────────────────

	let activeTypeFilter = $state<string | null>(null);
	let activeTagFilter = $state<string | null>(null);
	let searchQuery = $state('');

	// ─── Workspace Observation ───────────────────────────────────────────────────

	$effect(() => {
		entries = workspaceClient.tables.entries.getAllValid();

		const kvEntryId = workspaceClient.kv.get('selectedEntryId');
		selectedEntryId = kvEntryId.status === 'valid' ? kvEntryId.value : null;

		const unsubEntries = workspaceClient.tables.entries.observe(() => {
			entries = workspaceClient.tables.entries.getAllValid();
		});

		const unsubKv = workspaceClient.kv.observe(
			'selectedEntryId',
			(change) => {
				selectedEntryId = change.type === 'set' ? change.value : null;
			},
		);

		return () => {
			unsubEntries();
			unsubKv();
		};
	});

	// ─── Derived State ───────────────────────────────────────────────────────────

	const selectedEntry = $derived(
		entries.find((e) => e.id === selectedEntryId) ?? null,
	);

	/** Entries filtered by sidebar type/tag filters. */
	const filteredEntries = $derived.by(() => {
		let result = entries;
		if (activeTypeFilter) {
			result = result.filter((e) => e.type?.includes(activeTypeFilter));
		}
		if (activeTagFilter) {
			result = result.filter((e) => e.tags?.includes(activeTagFilter));
		}
		return result;
	});

	// ─── Document Handle (Y.Text) ────────────────────────────────────────────────

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
</script>

<SidebarProvider>
	<FujiSidebar
		{entries}
		{activeTypeFilter}
		{activeTagFilter}
		{searchQuery}
		onFilterByType={(type) => (activeTypeFilter = type)}
		onFilterByTag={(tag) => (activeTagFilter = tag)}
		onSearchChange={(query) => (searchQuery = query)}
		onSelectEntry={(id) => workspaceClient.kv.set('selectedEntryId', id)}
	/>

	<main class="flex h-screen flex-1 flex-col overflow-hidden">
		{#if selectedEntry}
			<div class="flex h-full items-center justify-center">
				<p class="text-muted-foreground">Editor placeholder — Wave 4</p>
			</div>
		{:else}
			<EntriesTable
				entries={filteredEntries}
				globalFilter={searchQuery}
				{selectedEntryId}
				onSelectEntry={(id) => workspaceClient.kv.set('selectedEntryId', id)}
				onAddEntry={() => {
					const id = generateId() as unknown as EntryId;
					workspaceClient.tables.entries.set({
						id,
						title: '',
						preview: '',
						createdAt: dateTimeStringNow(),
						updatedAt: dateTimeStringNow(),
						_v: 2,
					});
					workspaceClient.kv.set('selectedEntryId', id);
				}}
			/>
		{/if}
	</main>
</SidebarProvider>
