<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { basename } from '$lib/files.js';
	import { getSession } from '$lib/session.svelte.js';
	import FileView from '../components/FileView.svelte';
	import RecordingDetail from '../components/RecordingDetail.svelte';
	import RecordingList from '../components/RecordingList.svelte';

	const { library, view } = getSession();

	/** Below this width, the list and the details take turns. */
	const wide = new MediaQuery('(min-width: 768px)');

	async function back() {
		const path = library.selectedPath;
		view.showingDetail = false;
		await tick();
		if (path !== undefined)
			document.querySelector<HTMLElement>(`[data-recording="${CSS.escape(path)}"]`)?.focus();
	}
</script>

<svelte:head><title>Recordings · Whispering</title></svelte:head>

{#snippet detail(onBack: (() => void) | undefined)}
	{@const selection = library.selection}
	{#if selection?.kind === 'recording'}
		{#key selection.editor}
			<RecordingDetail {library} editor={selection.editor} entry={selection.entry} {onBack} />
		{/key}
	{:else if selection?.kind === 'file'}
		<FileView {library} path={selection.path} file={selection.file} {onBack} />
	{:else}
		<Empty.Root class="h-full">
			{#if library.selectedPath !== undefined}
				<Empty.Title>{basename(library.selectedPath)} is no longer in the folder</Empty.Title>
				<Empty.Description>It was renamed or deleted outside this window.</Empty.Description>
			{:else}
				<Empty.Title>Select a recording</Empty.Title>
				<Empty.Description>Its audio, transcripts, transformation results, notes, and source open here. Any other file opens from Files.</Empty.Description>
			{/if}
			{#if onBack}
				<Button variant="outline" size="sm" onclick={onBack}><ArrowLeftIcon /> Back to recordings</Button>
			{/if}
		</Empty.Root>
	{/if}
{/snippet}

{#if wide.current}
	<Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1">
		<Resizable.Pane id="list" order={1} defaultSize={38} minSize={20}>
			<RecordingList {library} bind:query={view.recordingQuery} />
		</Resizable.Pane>
		<Resizable.Handle />
		<Resizable.Pane id="detail" order={2} defaultSize={62} minSize={30}>
			{@render detail(undefined)}
		</Resizable.Pane>
	</Resizable.PaneGroup>
{:else if view.showingDetail}
	{@render detail(back)}
{:else}
	<RecordingList {library} bind:query={view.recordingQuery} onOpen={() => (view.showingDetail = true)} />
{/if}
