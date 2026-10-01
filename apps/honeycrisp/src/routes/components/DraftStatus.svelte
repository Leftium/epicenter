<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { toast } from '@epicenter/ui/sonner';
	import type { External, FileSession } from '$lib/file-session.svelte.js';
	import { basename } from '$lib/files.js';
	import { diffLines } from '$lib/line-diff.js';

	let {
		session,
		noun,
		onRecover,
		onDiscard,
	}: {
		session: FileSession;
		/** What the file is called in the recovery button. */
		noun: 'note' | 'file';
		/** Save a draft whose file is gone or unreadable as a file again. */
		onRecover: () => Promise<string | undefined>;
		/** Forget a draft whose file is gone or unreadable. */
		onDiscard: () => void;
	} = $props();

	const external = $derived(session.external);
	/** While the app answers a close, no choice here is taken. */
	const held = $derived(!session.admitting);
	/** A rename or delete whose outcome is not known, or a rename that left both files. */
	const stuck = $derived(
		session.pathChange !== undefined && session.pathChange.state !== 'sent'
			? session.pathChange
			: undefined,
	);
	/**
	 * The version the comparison was opened on. It does not follow the file:
	 * both choices name exactly this one, and stop being offered when the file
	 * has changed again.
	 */
	let reviewed = $state.raw<Extract<External, { kind: 'changed' }>>();
	const superseded = $derived(reviewed !== undefined && external !== reviewed);
	const diff = $derived(
		reviewed === undefined ? [] : diffLines(reviewed.current.source, session.buffer),
	);

	function review() {
		reviewed = external?.kind === 'changed' ? external : undefined;
	}

	async function copyDraft() {
		try {
			await navigator.clipboard.writeText(session.buffer);
			toast.success('Copied the draft');
		} catch {
			toast.error('Could not copy the draft', {
				description: 'Select the text in the Source view and copy it from there.',
			});
		}
	}

	async function recover() {
		const problem = await onRecover();
		if (problem) toast.error('Could not save the draft', { description: problem });
	}

	const changedAgain = () =>
		toast.warning('The file changed again', {
			description: 'Compare the new version before choosing.',
		});

	async function saveMine() {
		const chosen = reviewed;
		reviewed = undefined;
		if (chosen === undefined || !(await session.saveMine(chosen))) changedAgain();
	}

	function takeTheirs() {
		const chosen = reviewed;
		reviewed = undefined;
		if (chosen === undefined || !session.takeTheirs(chosen)) changedAgain();
	}
</script>

<!-- One file's state: saved, typing, saving, failed, not confirmed, or waiting on a choice. -->
<div class="flex min-h-9 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs" data-testid="draft-status" data-status={session.status}>
	{#if session.status === 'saving'}
		<span class="text-muted-foreground">
			{session.pathChange?.kind === 'move' ? 'Renaming…' : session.pathChange ? 'Deleting…' : 'Saving…'}
		</span>
		{#if session.attempt && session.buffer !== session.attempt.source}
			<span class="text-muted-foreground">Newer typing will be saved next.</span>
		{/if}
	{:else if stuck}
		<!-- Nothing here can show which file to go on with, so nothing is offered but the text. -->
		<span class="text-warning" role="alert">
			{#if stuck.kind === 'remove'}
				Deleting <code class="font-mono">{stuck.from.path}</code> was not confirmed. The file may or may not be
				there.
			{:else if stuck.state === 'partial'}
				Renaming this file created <code class="font-mono">{stuck.to}</code> but could not remove
				<code class="font-mono">{stuck.from.path}</code>. Both files exist with the same text.
			{:else}
				Renaming <code class="font-mono">{basename(stuck.from.path)}</code> to
				<code class="font-mono">{basename(stuck.to)}</code> was not confirmed. The file may be under either name.
			{/if}
			This editor saves nothing more and changes neither file. Copy anything typed since, then look in Files.
		</span>
		<Button size="xs" variant="outline" onclick={copyDraft}>Copy draft</Button>
	{:else if session.attempt?.state === 'unconfirmed'}
		<span class="text-warning" role="alert">
			The last save was not confirmed, so the file may or may not have it. Your draft is kept here, and nothing
			more is saved until that save is accounted for. Sending it again sends exactly that text.
			{#if external?.kind === 'changed'}
				The file holds other text now, so sending it again will be refused while it does.
			{:else if external !== undefined}
				The file is {external.kind === 'removed' ? 'not there' : 'not readable as text'} now.
			{/if}
		</span>
		<Button size="xs" disabled={held} onclick={() => void session.retry()}>Send it again</Button>
		<Button size="xs" variant="ghost" onclick={copyDraft}>Copy draft</Button>
	{:else if external?.kind === 'changed'}
		<span class="text-destructive" role="alert">
			This file changed on disk while you were editing. Your draft is kept here and is not saved.
		</span>
		<Button size="xs" disabled={held} onclick={review}>Compare and choose</Button>
	{:else if external?.kind === 'removed'}
		<span class="text-destructive" role="alert">
			This file was deleted on disk. Your draft is kept here and is not saved.
		</span>
		<Button size="xs" variant="outline" onclick={copyDraft}>Copy draft</Button>
		<Button size="xs" disabled={held} onclick={recover}>Save draft as a {noun}</Button>
		<Button size="xs" variant="ghost-destructive" disabled={held} onclick={onDiscard}>Discard draft</Button>
	{:else if external?.kind === 'unreadable'}
		<span class="text-destructive" role="alert">
			This file can no longer be read as text ({external.message}). Your draft is kept here.
		</span>
		<Button size="xs" variant="outline" onclick={copyDraft}>Copy draft</Button>
		<Button size="xs" disabled={held} onclick={recover}>Save draft as a {noun}</Button>
		<Button size="xs" variant="ghost-destructive" disabled={held} onclick={onDiscard}>Discard draft</Button>
	{:else if session.status === 'failed'}
		<span class="text-destructive" role="alert">Not saved: {session.failure}. Your draft is kept.</span>
		<Button size="xs" variant="outline" disabled={held} onclick={() => void session.retry()}>Try again</Button>
		<Button size="xs" variant="ghost" onclick={copyDraft}>Copy draft</Button>
	{:else if session.dirty}
		<span class="text-muted-foreground">Draft: unsaved typing</span>
		<!-- Typing saves by itself after a pause. This is for a draft nothing is
		     about to save, such as one left dirty when a save was found in the file. -->
		<Button size="xs" variant="ghost" disabled={held} onclick={() => void session.retry()}>Save</Button>
	{:else}
		<span class="text-muted-foreground">Saved to <code class="font-mono">{session.path}</code></span>
	{/if}
	{#if external !== undefined && session.failure && session.status === 'conflict'}
		<span class="text-destructive" role="status">The last save was refused: {session.failure}.</span>
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
				Red lines are only in the file on disk. Green lines are only in your draft.
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
