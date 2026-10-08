<!--
	What the person opened, shown the way the workspace they opened it from
	edits it. The timeline opens a capture's text and thoughts; Files opens a
	capture file's complete text. Neither turns into the other: a file that
	stops or starts reading as a capture stays where it was opened.

	Both open the one draft the page holds for the file, so a file has one
	publisher whichever workspace shows it, and nothing is handed between
	them. Each view is keyed by its draft, so a draft acquired again at the
	same path mounts a new view, and moving to the other workspace mounts the
	other view. A view reads its draft once, when it mounts: a view being
	taken down never acts for the next draft. The drafts live in `captures`,
	above every view, so moving between workspaces drops no input.
-->
<script module lang="ts">
	/** Where the person is: a workspace's list, the recovery screen, or one capture file as a workspace edits it. */
	export type Place =
		| { readonly kind: 'timeline' }
		| { readonly kind: 'files' }
		| { readonly kind: 'recover' }
		| { readonly kind: 'capture' | 'file'; readonly stem: string };
</script>

<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { untrack } from 'svelte';
	import type { Captures } from '$lib/captures.svelte.js';
	import CaptureDetail from './CaptureDetail.svelte';
	import FileDetail from './FileDetail.svelte';
	import Files from './Files.svelte';
	import Recovery from './Recovery.svelte';
	import TechnicalDetails from './TechnicalDetails.svelte';
	import Timeline from './Timeline.svelte';

	let {
		captures,
		place,
		created,
		go,
	}: {
		captures: Captures;
		place: Place;
		/** The capture just added from the timeline, so its view starts at Add a thought. */
		created: string | undefined;
		go: (place: Place, options?: { created?: boolean }) => void;
	} = $props();

	const stem = $derived(place.kind === 'capture' || place.kind === 'file' ? place.stem : undefined);
	const draft = $derived(stem === undefined ? undefined : captures.draft(stem));

	// A capture opened by its address opens its draft once its file is listed.
	$effect(() => {
		if (stem !== undefined && captures.has(stem) && captures.draft(stem) === undefined)
			untrack(() => captures.open(stem));
	});

	/** The list a capture's view returns to: the workspace it was opened from. */
	const list = $derived<Place>(place.kind === 'file' ? { kind: 'files' } : { kind: 'timeline' });
	const toCapture = (target: string) => go({ kind: 'capture', stem: target });
	const toFile = (target: string) => go({ kind: 'file', stem: target });
	// Deletion completes after its view may be gone; only the capture still shown is left.
	const deleted = (deletedStem: string) => {
		if (stem === deletedStem) go(list);
	};
</script>

{#if place.kind === 'recover'}
	<Recovery {captures} onOpen={toCapture} />
{:else if place.kind === 'capture' || place.kind === 'file'}
	{#if draft?.opened}
		{#if place.kind === 'capture'}
			{#key draft}
				<CaptureDetail
					{draft}
					{captures}
					focusNewThought={created === place.stem}
					onBack={() => go(list)}
					onDeleted={deleted}
					onOpen={toCapture}
					onFiles={toFile}
				/>
			{/key}
		{:else}
			{#key draft}
				<FileDetail
					{draft}
					{captures}
					onBack={() => go(list)}
					onDeleted={deleted}
					onOpen={toFile}
					onCapture={toCapture}
				/>
			{/key}
		{/if}
	{:else if draft || captures.has(place.stem)}
		<!-- Its saved file is listed; the editor over it is opening. -->
		<Loading label="Opening…" />
	{:else}
		{@const reason = captures.unreadableReason(place.stem)}
		<Empty.Root role="alert">
			<Empty.Header>
				{#if reason !== undefined}
					<Empty.Title>This capture's file cannot be read</Empty.Title>
					<Empty.Description>It is still in the folder, and this window did not write to it. Repair it with another program, then check again.</Empty.Description>
				{:else if captures.loaded}
					<Empty.Title>No capture named {place.stem}.md</Empty.Title>
					<Empty.Description>The folder has no file with this name. It may have been removed or renamed outside this window.</Empty.Description>
				{:else}
					<Empty.Title>This capture cannot be opened yet</Empty.Title>
					<Empty.Description>The captures folder has not been read.</Empty.Description>
				{/if}
			</Empty.Header>
			<Empty.Content>
				<div class="flex flex-wrap justify-center gap-2">
					<Button variant="outline" size="sm" onclick={() => captures.refresh()}>Check again</Button>
					<Button variant="outline" size="sm" onclick={() => go(list)}>{list.kind === 'files' ? 'Back to Files' : 'Back to timeline'}</Button>
				</div>
				{#if reason !== undefined}<TechnicalDetails detail={reason} />{/if}
			</Empty.Content>
		</Empty.Root>
	{/if}
{:else if place.kind === 'files'}
	<Files {captures} onOpen={toFile} />
{:else}
	<Timeline
		{captures}
		onOpen={toCapture}
		onRepair={toFile}
		onCreated={(target) => go({ kind: 'capture', stem: target }, { created: true })}
		onRecover={() => go({ kind: 'recover' })}
	/>
{/if}
