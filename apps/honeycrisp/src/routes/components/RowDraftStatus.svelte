<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { onDestroy } from 'svelte';
	import { basename } from '@epicenter/folder/file-browser';
	import { noteSaveProblem, reloadProblem, type TypedField } from '$lib/note-session.svelte.js';
	import type { NoteSession } from '$lib/notes.svelte.js';

	let {
		session,
		onStopTracking,
		onRecover,
	}: {
		session: NoteSession;
		/** Stop tracking a rename or delete that is not accounted for; the text stays. */
		onStopTracking: () => void;
		/** Save the editor's exact text as a new file: at its path when that is free, else as a new note. */
		onRecover: () => Promise<string | undefined>;
	} = $props();

	/** Cleared on destroy: a button something still holds can be clicked after this view is gone. */
	let mounted = true;
	onDestroy(() => {
		mounted = false;
	});
	/**
	 * Run a command only while this view is mounted and the button that asked
	 * is still on screen. A branch that is gone left its buttons detached for
	 * good; one kept and clicked later does nothing.
	 */
	const live = (command: () => unknown) => (event?: Event) => {
		if (!mounted) return;
		const target = event?.currentTarget;
		if (target instanceof Node && !target.isConnected) return;
		void command();
	};

	/** Read through to the owner's error, including during a newer save. */
	const failure = $derived('error' in session.save ? session.save.error : undefined);

	const FIELD_NAMES: Record<TypedField, string> = { title: 'the title', body: 'Source' };

	/** While the app answers a close, or a rename, delete, or reload runs, no choice here is taken. */
	const held = $derived(!session.canChoose);
	/** A rename or delete whose outcome is not known, or that left both files. */
	const stuck = $derived(
		session.pathChange !== undefined && session.pathChange.state !== 'sent'
			? session.pathChange
			: undefined,
	);
	const refused = $derived(Object.entries(session.refused) as [TypedField, { value: string; reason: string }][]);
	/** Text a reload could replace before it is in the file: a save that runs or stopped, or typing the editor refused. */
	const outstanding = $derived(session.save.status !== 'idle' || refused.length > 0);
	/** The file was not there at the last save or reload, and nothing else is being tracked. */
	const recoverable = $derived(session.missing && session.pathChange === undefined);
	/** Set while the person is asked whether a reload may replace text that is not saved. */
	let confirming = $state(false);

	async function copyText() {
		try {
			await navigator.clipboard.writeText(session.get().row.text);
			toast.success('Copied your text');
		} catch {
			toast.error('Could not copy your text', {
				description: 'Select it on screen and copy it from there.',
			});
		}
	}

	function report(title: string, problem: string | undefined) {
		if (problem) toast.error(title, { description: problem });
	}

	const retry = live(() => report('Could not save', session.retry()));
	const saveHere = live(() => report('Could not save', session.saveHere()));
	const recover = live(async () => report('Could not save your text as a file', await onRecover()));
	const stopTracking = live(() => onStopTracking());
	/** The person's reload. A failure keeps their text and is shown below. */
	const reload = live(async () => {
		confirming = false;
		await session.reload();
	});
	const askReload = live(() => {
		if (outstanding) confirming = true;
		else reload();
	});
	const keepText = live(() => {
		confirming = false;
	});
</script>

<!-- One note's state: saved, saving, failed, not confirmed, or a rename or delete that needs a choice. -->
<div class="flex min-h-9 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs" data-testid="draft-status" data-status={session.status}>
	{#if session.pathChange?.state === 'sent'}
		<span class="text-muted-foreground">{session.pathChange.kind === 'move' ? 'Renaming…' : 'Deleting…'}</span>
	{:else if stuck}
		<!-- Nothing here can show which file to go on with, so nothing is offered but the text. -->
		<span class="text-warning" role="alert">
			{#if stuck.kind === 'remove'}
				Deleting <code class="font-mono">{stuck.from.path}</code> was not confirmed. The file may or may not be
				there.
			{:else if stuck.state === 'sourceNotRemoved'}
				Renaming this note created <code class="font-mono">{stuck.to}</code> but could not remove
				<code class="font-mono">{stuck.from.path}</code>. Both files hold the same text.
			{:else}
				Renaming <code class="font-mono">{basename(stuck.from.path)}</code> to
				<code class="font-mono">{basename(stuck.to)}</code> was not confirmed. The note may be under either name.
			{/if}
			({stuck.problem}) This note takes no typing and saves nothing, so it changes neither file. Look in Files to see
			what is at each path. Stopping keeps your text here and concludes nothing about where the file is.
		</span>
		<Button size="xs" variant="outline" onclick={copyText}>Copy text</Button>
		<Button size="xs" variant="outline" disabled={held} onclick={stopTracking}>
			{stuck.kind === 'remove' ? 'Stop tracking this delete' : 'Stop tracking this rename'}
		</Button>
	{:else if session.hold}
		{@const change = session.hold.change}
		<!-- What is known about the rename or delete stays as it was known. -->
		<span class="text-warning" role="alert">
			{#if change.kind === 'remove'}
				Deleting <code class="font-mono">{change.from.path}</code> was not confirmed.
			{:else if change.state === 'sourceNotRemoved'}
				Renaming this note created <code class="font-mono">{change.to}</code> and could not remove
				<code class="font-mono">{change.from.path}</code>; both held the same text.
			{:else}
				Renaming <code class="font-mono">{change.from.path}</code> to <code class="font-mono">{change.to}</code> was
				not confirmed. The note may be under either name.
			{/if}
			You stopped tracking it. Nothing is typed or saved here until you save this text at
			<code class="font-mono">{session.path}</code> or reload that file.
		</span>
		<Button size="xs" variant="outline" disabled={held} onclick={saveHere}>Save at {basename(session.path)}</Button>
		<Button size="xs" variant="ghost" onclick={copyText}>Copy text</Button>
	{:else if failure}
		<!-- A failure stays visible until a newer save or explicit reload succeeds. -->
		{#if session.save.status === 'saving'}<span class="text-muted-foreground">Saving…</span>{/if}
		<span class={failure.name === 'Unconfirmed' ? 'text-warning' : 'text-destructive'} role="alert">
			{noteSaveProblem(failure)} Your text stays here. Your next edit saves again, or you can choose
			{failure.name === 'Unconfirmed' ? 'Save again' : 'Try again'} without changing it.
		</span>
		<Button size="xs" disabled={!session.admitting || session.save.status === 'saving'} onclick={retry}>
			{failure.name === 'Unconfirmed' ? 'Save again' : 'Try again'}
		</Button>
		<Button size="xs" variant="ghost" onclick={copyText}>Copy text</Button>
	{:else if session.save.status === 'saving'}
		<span class="text-muted-foreground">Saving…</span>
	{:else}
		<span class="text-muted-foreground">Saved to <code class="font-mono">{session.path}</code></span>
	{/if}
	{#if session.reloadError}
		<span class="text-destructive" role="status">{reloadProblem(session.reloadError)} Your text is unchanged.</span>
	{/if}
	{#if recoverable}
		<Button size="xs" variant="outline" disabled={held || session.save.status === 'saving'} onclick={recover}>
			Save as a note
		</Button>
	{/if}
	{#each refused as [field, typed] (field)}
		<span class="text-destructive" role="status">
			Not saved: what you typed in {FIELD_NAMES[field]} cannot be written ({typed.reason}). It stays there until you
			change it.
		</span>
	{/each}
	{#if session.refusal && !refused.some(([, typed]) => typed.reason === session.refusal)}
		<span class="text-warning" role="status">Change refused: {session.refusal}</span>
	{/if}
	{#if session.pathChange === undefined}
		<Button
			size="xs"
			variant="ghost"
			class="ml-auto"
			tooltip="Read the file again and show it here"
			disabled={held || confirming}
			onclick={askReload}
		>
			Reload file
		</Button>
	{/if}
</div>
{#if confirming && session.pathChange === undefined}
	<div class="flex flex-wrap items-center gap-2 border-b bg-destructive/5 px-4 py-1.5 text-xs" role="alert">
		<span>Reloading shows the file in place of your text, and your text that is not saved is lost.</span>
		<Button size="xs" variant="destructive" disabled={held} onclick={reload}>Reload and lose my text</Button>
		<Button size="xs" variant="ghost" onclick={keepText}>Keep my text</Button>
	</div>
{/if}
