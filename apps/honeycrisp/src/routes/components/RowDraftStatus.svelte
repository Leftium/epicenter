<script lang="ts">
	import type { RowObservation } from '@epicenter/folder';
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { toast } from '@epicenter/ui/sonner';
	import type { NoteFields } from '$lib/data.js';
	import { basename } from '$lib/files.js';
	import { diffLines } from '$lib/line-diff.js';
	import type { NoteSession } from '$lib/notes.svelte.js';

	let {
		session,
		onDiscard,
		onStopTracking,
	}: {
		session: NoteSession;
		/** Forget a draft whose file is gone, unreadable, or no longer a note this editor can hold. */
		onDiscard: () => void;
		/** Stop tracking a rename or delete that is not accounted for; the draft stays. */
		onStopTracking: () => void;
	} = $props();

	type Present = Extract<RowObservation<NoteFields>, { kind: 'present' }>;

	const row = $derived(session.state);
	const external = $derived(session.external);
	/** While the app answers a close, no choice here is taken. */
	const held = $derived(!session.admitting);
	/** A rename or delete whose outcome is not known, that left both files, or whose new name could not be opened. */
	const stuck = $derived(
		session.pathChange !== undefined && session.pathChange.state !== 'sent'
			? session.pathChange
			: undefined,
	);
	/**
	 * The version the comparison was opened on. It does not follow the file:
	 * both choices name exactly this one, and stop being offered when the file
	 * holds other content.
	 */
	let reviewed = $state.raw<Present>();
	const superseded = $derived(
		reviewed !== undefined &&
			(external?.kind !== 'present' ||
				external.revision.canonical !== reviewed.revision.canonical),
	);
	const diff = $derived(
		reviewed === undefined ? [] : diffLines(reviewed.revision.canonical, row.source),
	);

	function review() {
		reviewed = external?.kind === 'present' ? external : undefined;
	}

	async function copyDraft() {
		try {
			await navigator.clipboard.writeText(row.source);
			toast.success('Copied the draft');
		} catch {
			toast.error('Could not copy the draft', {
				description: 'Select the text in the Source view and copy it from there.',
			});
		}
	}

	async function save() {
		const problem = await session.saveNow();
		if (problem) toast.error('Could not save the draft', { description: problem });
	}

	const changedAgain = () =>
		toast.warning('The file changed again', {
			description: 'Compare the new version before choosing.',
		});

	async function saveMine() {
		const chosen = reviewed;
		reviewed = undefined;
		if (chosen === undefined || superseded) return changedAgain();
		await save();
	}

	/** Keep the file as the latest read found it, in place of the draft. */
	function keepFile() {
		const seen = row.observation;
		if (seen.kind !== 'present' || !session.adopt(seen.revision)) changedAgain();
	}

	function takeTheirs() {
		const chosen = reviewed;
		reviewed = undefined;
		if (chosen === undefined || !session.adopt(chosen.revision)) changedAgain();
	}
</script>

<!-- One note's state: saved, typing, saving, failed, not confirmed, or waiting on a choice. -->
<div class="flex min-h-9 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs" data-testid="draft-status" data-status={session.status}>
	{#if session.status === 'saving'}
		<span class="text-muted-foreground">
			{session.pathChange?.kind === 'move' ? 'Renaming…' : session.pathChange ? 'Deleting…' : 'Saving…'}
		</span>
		{#if row.saving && row.source !== row.saving.source}
			<span class="text-muted-foreground">Newer typing will be saved next.</span>
		{/if}
	{:else if stuck}
		<!-- Nothing here can show which file to go on with, so nothing is offered but the text. -->
		<span class="text-warning" role="alert">
			{#if stuck.kind === 'remove'}
				Deleting <code class="font-mono">{stuck.from.path}</code> was not confirmed. The file may or may not be
				there.
			{:else if stuck.state === 'stranded'}
				This note was renamed to <code class="font-mono">{basename(stuck.to)}</code>, but could not be opened
				there ({stuck.problem}).
			{:else if stuck.state === 'sourceNotRemoved'}
				Renaming this note created <code class="font-mono">{stuck.to}</code> but could not remove
				<code class="font-mono">{stuck.from.path}</code>. Both files hold the same text.
			{:else}
				Renaming <code class="font-mono">{basename(stuck.from.path)}</code> to
				<code class="font-mono">{basename(stuck.to)}</code> was not confirmed. The note may be under either name.
			{/if}
			This editor saves nothing more and changes neither file. Look in Files to see what is at each path.
			Stopping keeps your draft here and concludes nothing about where the file is.
		</span>
		<Button size="xs" variant="outline" onclick={copyDraft}>Copy draft</Button>
		<Button size="xs" variant="outline" disabled={held} onclick={onStopTracking}>
			{stuck.kind === 'remove' ? 'Stop tracking this delete' : 'Stop tracking this rename'}
		</Button>
	{:else if session.hold?.kind === 'detached'}
		{@const change = session.hold.change}
		<!-- What is known about the rename or delete stays as it was known. The read
		     below is about this path now, and says nothing about who changed it. -->
		<span class="text-warning" role="alert">
			{#if change.kind === 'remove'}
				Deleting <code class="font-mono">{change.from.path}</code> was not confirmed.
			{:else if change.state === 'stranded'}
				This note was moved to <code class="font-mono">{change.to}</code>, and could not be opened there
				({change.problem}).
			{:else if change.state === 'sourceNotRemoved'}
				Renaming this note created <code class="font-mono">{change.to}</code> and could not remove
				<code class="font-mono">{change.from.path}</code>; both held the same text.
			{:else}
				Renaming <code class="font-mono">{change.from.path}</code> to <code class="font-mono">{change.to}</code> was
				not confirmed. The note may be under either name.
			{/if}
			You stopped tracking it.
			{#if row.observation.kind === 'missing'}
				<code class="font-mono">{session.path}</code> is not there now.
			{:else if row.observation.kind === 'present'}
				<code class="font-mono">{session.path}</code>
				{external === undefined ? 'holds the text this editor last read.' : 'holds other text now.'}
			{:else}
				<code class="font-mono">{session.path}</code> cannot be read as this note now.
			{/if}
			Your draft is kept here, and nothing is saved by itself.
			{#if row.observation.kind === 'missing'}
				Saving writes <code class="font-mono">{session.path}</code> again{#if change.kind === 'move'}; <code
						class="font-mono">{change.to}</code> may hold the note too{/if}.
			{/if}
		</span>
		<Button size="xs" variant="outline" disabled={held} onclick={save}>Save at {basename(session.path)}</Button>
		{#if external?.kind === 'present'}
			<Button size="xs" variant="outline" disabled={held} onclick={review}>Compare and choose</Button>
		{:else if row.observation.kind === 'present'}
			<Button size="xs" variant="ghost" disabled={held} onclick={keepFile}>
				{row.isDirty ? 'Discard my draft and keep the file' : 'Keep the file as it is'}
			</Button>
		{/if}
		<Button size="xs" variant="ghost-destructive" disabled={held} onclick={onDiscard}>Discard draft</Button>
		<Button size="xs" variant="ghost" onclick={copyDraft}>Copy draft</Button>
	{:else if session.status === 'unconfirmed'}
		<span class="text-warning" role="alert">
			The last save was not confirmed, so the file may or may not have it. Your draft is kept here, and nothing
			more is saved until you choose.
			{#if external?.kind === 'present'}
				The file holds other text now.
			{:else if external !== undefined}
				The file is {external.kind === 'missing' ? 'not there' : 'not readable as a note'} now.
			{:else if !row.isDirty}
				The file holds this draft now; that does not show which save put it there.
			{/if}
		</span>
		<!-- Each choice is the person's: a new save of what is on screen, or the file as it is. -->
		<Button size="xs" disabled={held} onclick={save}>Save again</Button>
		{#if row.observation.kind === 'present'}
			<Button size="xs" variant="outline" disabled={held} onclick={keepFile}>
				{row.isDirty ? 'Discard my draft and keep the file' : 'Keep the file as it is'}
			</Button>
		{:else}
			<Button size="xs" variant="ghost-destructive" disabled={held} onclick={onDiscard}>Discard draft</Button>
		{/if}
		<Button size="xs" variant="ghost" onclick={copyDraft}>Copy draft</Button>
	{:else if external?.kind === 'present'}
		<span class="text-destructive" role="alert">
			This note changed on disk while you were editing. Your draft is kept here and is not saved.
		</span>
		<Button size="xs" disabled={held} onclick={review}>Compare and choose</Button>
	{:else if external !== undefined}
		<span class="text-destructive" role="alert">
			{#if external.kind === 'missing'}
				This note is no longer at this path.
			{:else if external.kind === 'unreadable'}
				This note can no longer be read as text ({external.error.message}).
			{:else}
				This note's file changed on disk into text this editor cannot hold.
			{/if}
			Your draft is kept here and is not saved.
		</span>
		<Button size="xs" variant="outline" onclick={copyDraft}>Copy draft</Button>
		<Button size="xs" disabled={held} onclick={save}>
			{external.kind === 'missing' ? 'Save draft as a note' : 'Save my draft over the file'}
		</Button>
		<Button size="xs" variant="ghost-destructive" disabled={held} onclick={onDiscard}>
			{external.kind === 'invalid' || external.kind === 'unsupported' ? 'Discard draft and repair the file' : 'Discard draft'}
		</Button>
	{:else if session.status === 'failed' && session.hold}
		<!-- The hold stands even when the file now holds this draft: that is what the
		     file holds, not an answer about the save. -->
		<span class="text-destructive" role="alert">
			Not saved: {session.hold.message}. Your draft is kept, and nothing more is saved until you choose.
			{#if !row.isDirty}
				The file holds this draft now; that does not show what happened to the save.
			{/if}
		</span>
		<Button size="xs" variant="outline" disabled={held} onclick={save}>Try again</Button>
		{#if row.observation.kind === 'present'}
			<Button size="xs" variant="ghost" disabled={held} onclick={keepFile}>
				{row.isDirty ? 'Discard my draft and keep the file' : 'Keep the file as it is'}
			</Button>
		{/if}
		<Button size="xs" variant="ghost" onclick={copyDraft}>Copy draft</Button>
	{:else if row.isDirty}
		<span class="text-muted-foreground">Draft: unsaved typing</span>
		<Button size="xs" variant="ghost" disabled={held} onclick={save}>Save</Button>
	{:else}
		<span class="text-muted-foreground">Saved to <code class="font-mono">{session.path}</code></span>
	{/if}
	{#if session.notice}
		<span class="text-destructive" role="status">Not saved: {session.notice}</span>
	{/if}
	{#if session.refusal}
		<span class="text-warning" role="status">Change refused: {session.refusal}</span>
	{/if}
</div>

<Dialog.Root
	open={reviewed !== undefined}
	onOpenChange={(open) => {
		if (!open) reviewed = undefined;
	}}
>
	<Dialog.Content class="flex max-h-[85vh] flex-col sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title>Compare the file with your draft</Dialog.Title>
			<Dialog.Description>
				Red lines are only in the file on disk. Green lines are only in your draft. Both are shown as the note
				saves them, so differences in comments and spelling are not shown.
			</Dialog.Description>
		</Dialog.Header>
		{#if superseded}
			<p class="flex flex-wrap items-center gap-2 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs" role="alert">
				The file changed again after this comparison opened. What is shown below is no longer what is on disk.
				<Button size="xs" variant="outline" disabled={held} onclick={review}>Show the file as it is now</Button>
			</p>
		{/if}
		<pre class="min-h-0 flex-1 overflow-auto rounded border bg-muted/30 p-2 font-mono text-xs" data-testid="compare">{#each diff as line, index (index)}<span
					class={line.kind === 'removed'
						? 'block bg-destructive/15 text-destructive'
						: line.kind === 'added'
							? 'block bg-success/15 text-success'
							: 'block text-muted-foreground'}>{line.kind === 'removed' ? '- ' : line.kind === 'added' ? '+ ' : '  '}{line.text}</span>{/each}</pre>
		<!-- This dialog is outside the app's inert root, so it holds its own buttons back. -->
		<Dialog.Footer>
			<Button variant="outline" disabled={superseded || held} onclick={takeTheirs}>Discard my draft and load the file</Button>
			<Button disabled={superseded || held} onclick={() => void saveMine()}>Save my draft over the file</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
