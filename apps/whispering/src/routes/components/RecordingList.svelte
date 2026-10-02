<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Link } from '@epicenter/ui/link';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { resolve } from '$app/paths';
	import { audioPathIn } from '$lib/definition.js';
	import type { RecordingEntry } from '$lib/editor.svelte.js';
	import type { Library } from '$lib/library.svelte.js';
	import { committedState } from '$lib/status.js';
	import { formatTime, recordingTitle } from './file-actions.js';

	let { library, query = $bindable(), onOpen }: {
		library: Library;
		/** The filter text. The page keeps it, so it is still there after a visit elsewhere. */
		query: string;
		onOpen?: () => void;
	} = $props();

	const needle = $derived(query.trim().toLowerCase());

	/** Whether the title, notes, ID, or any transcript of a recording contains the filter text. */
	function matches(entry: RecordingEntry) {
		const texts = [
			recordingTitle(entry),
			entry.stem,
			entry.body ?? '',
			...library.resultsFor(entry.stem).map((result) => result.body ?? ''),
		];
		return texts.some((text) => text.toLowerCase().includes(needle));
	}

	// A row that needs repair is always listed: a filter must never hide the
	// one file the person has to fix, and its title may be unreadable anyway.
	const visible = $derived(
		needle === '' ? library.entries : library.entries.filter((entry) => entry.issues !== undefined || matches(entry)),
	);
	const hidden = $derived(library.entries.length - visible.length);

	function historyOf(entry: RecordingEntry) {
		const audioPath = audioPathIn(entry.fields);
		return committedState(library.git, [entry.path, ...(audioPath ? [audioPath] : [])]);
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Recordings">
	<div class="flex flex-col gap-3 border-b px-3 py-3 sm:px-4">
		<SectionHeader.Root>
			<SectionHeader.Title level={1} class="text-lg">Recordings</SectionHeader.Title>
			<SectionHeader.Description class="text-xs">
				{library.entries.length === 1 ? '1 recording' : `${library.entries.length} recordings`} in the folder{#if hidden > 0}, {hidden} hidden by the filter{/if}
			</SectionHeader.Description>
		</SectionHeader.Root>
		<div class="relative">
			<SearchIcon class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
			<Input
				type="search"
				class="ps-8"
				bind:value={query}
				placeholder="Filter by title, notes, or transcript"
				aria-label="Filter recordings"
				autocomplete="off"
				data-testid="recording-filter"
			/>
		</div>
	</div>

	{#if library.listError}
		<p class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive" role="status">
			Could not read the recordings folder: {library.listError}. Showing the last list that was read.
		</p>
	{/if}

	<ul class="min-h-0 flex-1 overflow-y-auto" aria-label="Saved recordings" data-testid="recording-list">
		{#each visible as entry (entry.path)}
			{@const selected = library.selectedPath === entry.path}
			{@const history = historyOf(entry)}
			{@const count = library.resultsFor(entry.stem).length}
			<li class="border-b text-sm {selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'}">
				<button
					type="button"
					class="flex w-full min-w-0 flex-col gap-0.5 px-3 py-2 text-left sm:px-4"
					aria-current={selected ? 'true' : undefined}
					data-recording={entry.path}
					onclick={() => {
						void library.open(entry.path);
						onOpen?.();
					}}
				>
					<span class="flex items-center gap-2">
						<span class="truncate font-medium">{recordingTitle(entry)}</span>
						{#if entry.issues}<Badge variant="destructive" class="shrink-0">Needs repair</Badge>{/if}
						{#if entry.fields.capture === 'fixture'}<Badge variant="outline" class="shrink-0">Fixture</Badge>{/if}
					</span>
					<span class="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
						<span>{formatTime(entry.fields.recordedAt, 'short') || entry.path}</span>
						{#if count > 0}<span>· {count} {count === 1 ? 'transcription' : 'transcriptions'}</span>{/if}
						{#if !audioPathIn(entry.fields)}<span>· names no audio</span>{/if}
						{#if history === 'uncommitted'}<span data-testid="row-history">· saved, not in history yet</span>{/if}
					</span>
				</button>
			</li>
		{:else}
			<li>
				<Empty.Root class="py-10">
					<Empty.Header>
						<Empty.Media variant="icon">
							{#if needle}<SearchIcon />{:else}<MicIcon />{/if}
						</Empty.Media>
						<Empty.Title>{needle ? 'No recordings match' : 'No recordings yet'}</Empty.Title>
						<Empty.Description>
							{#if needle}
								Nothing has “{query.trim()}” in its title, notes, or transcript.
							{:else}
								Record from <Link href={resolve('/')}>Home</Link>, or add
								<code class="font-mono">recordings/&lt;id&gt;.md</code> in the terminal.
							{/if}
						</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			</li>
		{/each}
	</ul>

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
