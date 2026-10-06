<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Label } from '@epicenter/ui/label';
	import { cn } from '@epicenter/ui/utils';
	import { toast } from '@epicenter/ui/sonner';
	import { onDestroy, untrack } from 'svelte';
	import { type Entry, STAGE_LABELS, STAGES } from '$lib/data.js';
	import { type EntriesState, entryErrorMessage } from '$lib/entries.svelte.js';
	import { describeRowError, describeSaveError } from '$lib/word.svelte.js';
	import NoteField from './NoteField.svelte';
	import RepairField from './RepairField.svelte';

	let { entry, entries, chosen, canChoose, onToggle }: {
		entry: Entry;
		entries: EntriesState;
		chosen: boolean;
		canChoose: boolean;
		onToggle: () => void;
	} = $props();

	// The word's row editor, shared with every other view of this word. It is
	// kept by the words list, so input and a failed save outlive this card.
	// Every command below reads `word` when it runs, so a card given another
	// entry acts on that entry's word.
	const word = $derived(entries.word(entry.id));
	const stage = $derived(word.stage());
	const failure = $derived.by(() => {
		const save = word.save;
		return save !== undefined && 'error' in save ? save.error : undefined;
	});
	/**
	 * The word whose file text the learner is editing. Only which view to show:
	 * it keeps the text in view while it becomes a valid word mid-edit.
	 */
	let sourceOf = $state<string | undefined>();
	const view = $derived(word.row?.status === 'invalid' || sourceOf === entry.id ? 'source' : 'fields');

	// Open the shown word's editor as soon as the card shows it, so its note
	// field is ready before the learner reaches it. Only a change of word runs
	// this again: a failed attempt is retried by the learner, not by a loop.
	$effect(() => {
		const shown = word;
		untrack(() => void shown.open());
	});

	/** Cleared on destroy: a button's listener outlives the card on a retained element. */
	let mounted = true;
	onDestroy(() => {
		mounted = false;
	});

	/**
	 * Run a command only while this card is mounted, and show what it
	 * answered. Each message says what happened, refused or unknown, so no
	 * title is put over it.
	 */
	async function act(command: () => Promise<string | null>) {
		if (!mounted) return;
		const message = await command();
		if (message !== null) toast.error(message);
	}

	/**
	 * Ask before deleting the word this card shows now. The words list and the
	 * entry as listed are fixed at the press, so a card given another entry or
	 * list while the dialog is open, or gone from the page, still deletes only
	 * the word that was named, at the version that was shown. Deleting
	 * discards what the word holds unsaved, so the dialog says so every time.
	 */
	function confirmDelete() {
		if (!mounted) return;
		const words = entries;
		const chosen = entry;
		confirmationDialog.open({
			title: `Delete “${chosen.text}”?`,
			description: 'Its note and stage are deleted with it. Any change not saved yet, including a note that could not be saved, is discarded.',
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				const { error: removeError } = await words.remove(chosen);
				if (removeError !== null) toast.error(entryErrorMessage(removeError));
			},
		});
	}
</script>

<article class={cn("rounded-lg border p-4", chosen && "border-primary bg-accent/30")}>
	<div class="flex items-start justify-between gap-2">
		<Label class="min-h-11 min-w-0 flex-1 items-start text-base leading-relaxed select-text"><Checkbox class="mt-1 shrink-0" aria-label="Choose {entry.text} for chat" checked={chosen} disabled={!canChoose} onCheckedChange={onToggle} /><span class="min-w-0 flex-1 wrap-anywhere">{entry.text}</span></Label>
		<Button size="sm" variant="ghost-destructive" class="shrink-0" disabled={word.fenced} onclick={confirmDelete}>Delete</Button>
	</div>
	{#if view === 'source'}
		<!-- The file's exact text, through the same editor: each change is saved as typed. -->
		<div class="space-y-2 text-xs">
			{#if word.row?.status === 'invalid'}
				<p role="alert" class="text-destructive">This word’s file is not a valid word, so its note and stage cannot be shown. Edit its text here; each change is saved. ({describeRowError(word.row.error)})</p>
			{/if}
			<RepairField {word} label="File text for {entry.text}" oninput={() => { sourceOf = entry.id; }} />
			{#if word.row?.status === 'valid'}
				<Button size="sm" variant="ghost" onclick={() => { sourceOf = undefined; }}>Show note and stage</Button>
			{/if}
		</div>
	{:else}
		<NoteField {word} label="Your note for {entry.text}" />
		{#if word.refusedNote !== undefined}
			<!-- The note as typed stays in the field above; nothing was sent. -->
			<div role="alert" class="mt-2 space-y-2 text-xs text-destructive">
				<p>Your note cannot be saved as typed, so nothing was sent. It stays in the field until you correct it, discard it, or delete the word. ({word.refusedNote.reason})</p>
				<Button size="sm" variant="ghost" onclick={() => { if (mounted) word.discardRefusedNote(); }}>Discard this note</Button>
			</div>
		{/if}
		{#if word.openError !== undefined && !word.missing}
			<div role="alert" class="mt-2 space-y-2 text-xs text-destructive">
				<p>{word.openError}</p>
				<Button size="sm" variant="outline" disabled={word.opening || word.fenced} onclick={() => { if (mounted) void word.open(); }}>Try opening again</Button>
			</div>
		{/if}
		<div class="mt-2 flex flex-wrap gap-1" aria-label="Your stage for {entry.text}">
			{#each STAGES as option}<Button size="sm" variant={stage === option ? 'default' : 'outline'} aria-pressed={stage === option} disabled={!word.stageable} onclick={() => act(() => word.setStage(option))}>{STAGE_LABELS[option]}</Button>{/each}
		</div>
	{/if}
	{#if word.missing}
		<!-- No save creates a gone file. What the learner typed stays shown above until they let it go. -->
		<div role="alert" class="mt-2 space-y-2 text-xs text-destructive">
			<p>{word.deletion === undefined ? 'This word’s file is gone from the folder, so nothing here is saved to it.' : 'Deleting this word was not confirmed, and its file is now gone.'} What is shown stays here until you let it go.</p>
			<div class="flex flex-wrap gap-1">
				{#if word.row !== undefined}
					<Button size="sm" variant="outline" disabled={word.fenced} onclick={() => act(() => word.reload())}>Check again</Button>
				{/if}
				<Button size="sm" variant="ghost-destructive" class="shrink-0" disabled={word.fenced} onclick={() => { if (mounted) void entries.letGo(entry.id); }}>Let it go</Button>
			</div>
		</div>
	{:else if word.deletion !== undefined}
		<!-- A delete with no answer: the word may be gone. -->
		<div role="alert" class="mt-2 space-y-2 text-xs text-destructive">
			<p>Deleting this word could not be confirmed. ({word.deletion})</p>
			<div class="flex flex-wrap gap-1">
				<Button size="sm" variant="outline" disabled={word.fenced} onclick={() => act(() => word.reload())}>Check again</Button>
				<Button size="sm" variant="ghost-destructive" class="shrink-0" disabled={word.fenced} onclick={() => { if (mounted) void entries.letGo(entry.id); }}>Let it go</Button>
			</div>
		</div>
	{:else if failure}
		<!-- The learner's input stays shown above; another edit starts another save. -->
		<div role="alert" class="mt-2 space-y-2 text-xs text-destructive">
			<p>{describeSaveError(failure)} {word.save?.status === 'saving' ? 'Saving your latest edit.' : ''} Your text stays here. Your next edit saves again, or choose Try again without changing it.</p>
			<div class="flex flex-wrap gap-1">
				<Button size="sm" variant="outline" disabled={word.fenced || word.save?.status === 'saving'} onclick={() => { if (mounted) word.retry(); }}>Try again</Button>
				<Button size="sm" variant="ghost-destructive" class="shrink-0" disabled={word.fenced} onclick={() => act(() => word.reload())}>Discard mine and reload the file</Button>
			</div>
		</div>
	{:else if word.row !== undefined}
		<!-- The editor read the file once; another tab's change shows only when the learner asks. -->
		<Button class="mt-2" size="sm" variant="ghost" disabled={word.fenced || word.refusedNote !== undefined} onclick={() => act(() => word.reload())}>Reload file</Button>
	{/if}
</article>
