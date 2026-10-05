<!--
	Test fixture: the recordings page's and the transformations page's detail
	views, rendered as those pages render them. A transcript or file selection
	reuses one FileView for every selected path, unkeyed; a transformation is
	keyed by its path. `shown` unmounts the views, as closing the details does,
	while the library and its drafts stay.
-->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { Library } from '$lib/library.svelte.js';
	import FileView from '../FileView.svelte';
	import RecordingDetail from '../RecordingDetail.svelte';
	import TransformationDetail from '../TransformationDetail.svelte';

	let { library, page }: { library: Library; page: { shown: boolean; tab: 'recordings' | 'transformations' } } =
		$props();
	let applyTo = $state<string | undefined>();
	let applySource = $state<'transcript' | 'pasted'>('transcript');
	let pastedText = $state('');
	let tryItFor = $state<string | undefined>();
</script>

<Tooltip.Provider>
	{#if page.shown && page.tab === 'recordings'}
		{@const selection = library.selection}
		{#if selection?.kind === 'recording'}
			{#key selection.path}
				<RecordingDetail {library} path={selection.path} slot={selection.slot} entry={selection.entry} />
			{/key}
		{:else if selection?.kind === 'transcript'}
			<FileView {library} path={selection.path} file={{ kind: 'row', slot: selection.slot }} />
		{:else if selection?.kind === 'file'}
			<FileView {library} path={selection.path} file={selection.file} />
		{/if}
	{:else if page.shown && page.tab === 'transformations'}
		{@const selected = library.selectedTransformation}
		{#if selected}
			{#key selected.path}
				<TransformationDetail
					{library}
					path={selected.path}
					slot={selected.slot}
					entry={selected.entry}
					bind:applyTo
					bind:applySource
					bind:pastedText
					bind:tryItFor
					onOpenFile={() => {}}
				/>
			{/key}
		{/if}
	{/if}
</Tooltip.Provider>
