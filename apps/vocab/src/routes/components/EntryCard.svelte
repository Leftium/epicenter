<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Label } from '@epicenter/ui/label';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { type Entry, STAGE_LABELS, STAGES } from '$lib/data.js';
	import { type EntriesState, type EntryError, entryErrorMessage } from '$lib/entries.svelte.js';

	let { entry, entries, chosen, canChoose, onToggle }: {
		entry: Entry;
		entries: EntriesState;
		chosen: boolean;
		canChoose: boolean;
		onToggle: () => void;
	} = $props();

	// The word's note and stage, shared with every other view of this word. It
	// is kept by the words list, so a note being typed outlives this card.
	const word = $derived(entries.word(entry.id));
	const outcome = $derived(word.outcome);
	const review = $derived(word.review);
	const stage = $derived(word.stage(entry.stage));
	const busy = $derived(word.saving || word.gated);

	function report(message: string | null) {
		if (message !== null) toast.error('Not saved', { description: message });
	}
	function reportEntry(error: EntryError | null) {
		if (error !== null) toast.error('Not saved', { description: entryErrorMessage(error) });
	}
</script>

<article class="rounded-lg border p-4">
	<div class="flex items-center justify-between gap-2">
		<Label class="min-h-11 text-base leading-normal select-text"><Checkbox aria-label="Choose {entry.text} for chat" checked={chosen} disabled={!canChoose} onCheckedChange={onToggle} />{entry.text}</Label>
		<Button size="sm" variant="ghost" disabled={word.gated} onclick={async () => { const { error: removeError } = await entries.remove(entry.id); reportEntry(removeError); }}>Delete</Button>
	</div>
	{#if word.mode.kind === 'repair'}
		<div role="alert" class="space-y-2 text-xs">
			<p class="text-destructive">This word's file cannot be edited here until it is repaired: {word.mode.reason}</p>
			<Textarea
				class="min-h-24 font-mono text-xs"
				aria-label="File text for {entry.text}"
				readonly={word.gated}
				bind:value={() => word.repairText ?? '', (text) => word.inputRepair(text)}
			/>
			{#if word.repairProblem}<p class="text-destructive">{word.repairProblem}</p>{/if}
			<Button size="sm" variant="outline" disabled={busy} onclick={() => word.writeRepair()}>Save this text</Button>
			{#if word.pendingNote !== undefined}
				<p class="text-destructive">Your note is kept here, not saved. It is added once the file is repaired:</p>
				<p class="rounded border p-2 whitespace-pre-wrap text-foreground">{word.pendingNote || '(empty)'}</p>
				<Button size="sm" variant="ghost" disabled={word.gated} onclick={() => word.discardNote()}>Discard this note</Button>
			{/if}
		</div>
	{:else}
		<!-- The field always shows the word's own note: a choice made elsewhere replaces what it shows. -->
		<Textarea
			class="min-h-20"
			aria-label="Your note for {entry.text}"
			placeholder="Your note"
			readonly={word.gated}
			bind:value={() => word.note(entry.note), (text) => word.inputNote(text)}
			onfocus={() => void word.open()}
			onblur={() => void word.blur()}
		/>
		{#if word.mode.kind === 'unavailable' && word.unsettled}
			<p role="alert" class="mt-2 text-xs text-destructive">Your note is not saved: {word.mode.message}</p>
		{/if}
		{#if word.issues.length}
			<p role="alert" class="mt-2 text-xs text-destructive">This word cannot be saved as it is: {word.issues.join('; ')}</p>
		{/if}
	{/if}
	{#if outcome?.kind === 'deletion'}
		<!-- A delete with no answer: the word may be gone. Nothing writes it until a choice. -->
		<div role="alert" class="mt-2 space-y-2 text-xs text-destructive">
			<p>Deleting this word could not be confirmed, so it may or may not be gone. It stays here, and nothing is saved until you choose. ({outcome.message})</p>
			<div class="flex flex-wrap gap-1">
				<Button size="sm" variant="outline" disabled={busy || review?.kind === 'unreadable'} onclick={async () => report(await word.saveMine())}>Keep it: save it</Button>
				{#if word.state?.observation.kind === 'present'}
					<Button size="sm" variant="ghost" disabled={busy} onclick={() => report(word.keepSaved())}>Keep it as it is saved</Button>
				{/if}
				<Button size="sm" variant="ghost" disabled={busy} onclick={() => void entries.letGo(entry.id)}>Let it go</Button>
			</div>
		</div>
	{:else if outcome}
		<!-- What became of an earlier save. What the file holds now is shown below, on its own. -->
		<div role="alert" class="mt-2 space-y-2 text-xs text-destructive">
			<p>
				{#if outcome.kind === 'unconfirmed'}
					Your last change could not be confirmed. Whether it was saved is not known, and nothing is sent again until you choose.
				{:else}
					Your last change was not saved. Nothing is sent again until you choose.
				{/if}
				({outcome.message})
			</p>
			{#if review === undefined}
				<div class="flex gap-1">
					<Button size="sm" variant="outline" disabled={busy} onclick={async () => report(await word.saveMine())}>Try again</Button>
					<Button size="sm" variant="ghost" disabled={busy} onclick={() => report(word.keepSaved())}>Keep the saved word</Button>
				</div>
			{/if}
		</div>
	{/if}
	{#if review?.kind === 'changed'}
		<div role="alert" class="mt-2 space-y-2 text-xs text-destructive">
			<p>This word changed in another tab while you were typing, so your note is not saved. The saved note is now:</p>
			<p class="rounded border p-2 whitespace-pre-wrap text-foreground">{typeof review.note === 'string' ? review.note || '(empty)' : JSON.stringify(review.note)}</p>
			<div class="flex gap-1">
				<Button size="sm" variant="outline" disabled={busy} onclick={async () => report(await word.saveMine())}>Save mine instead</Button>
				<Button size="sm" variant="ghost" disabled={busy} onclick={() => report(word.keepSaved())}>Keep the saved note</Button>
			</div>
		</div>
	{:else if review?.kind === 'invalid'}
		<div role="alert" class="mt-2 space-y-2 text-xs text-destructive">
			<p>This word was changed in another tab into text Vocab cannot read as a word ({review.message}). Your note is not saved over it until you choose. The file now:</p>
			<pre class="max-h-40 overflow-auto rounded border p-2 whitespace-pre-wrap text-foreground">{review.file.text}</pre>
			<div class="flex flex-wrap gap-1">
				<Button size="sm" variant="outline" disabled={busy} onclick={async () => report(await word.saveMine())}>Save my word over it</Button>
				<Button size="sm" variant="ghost" disabled={busy} onclick={() => word.repairFile()}>Repair the file's text (discard my note)</Button>
			</div>
		</div>
	{:else if review}
		<div role="alert" class="mt-2 space-y-2 text-xs text-destructive">
			<p>This word cannot be read just now, so nothing is saved over it. Your note is kept here. ({review.message})</p>
			<Button size="sm" variant="outline" disabled={busy} onclick={() => word.refresh()}>Check again</Button>
		</div>
	{/if}
	<div class="mt-2 flex flex-wrap gap-1" aria-label="Your stage for {entry.text}">
		{#each STAGES as option}<Button size="sm" variant={stage === option ? 'default' : 'outline'} aria-pressed={stage === option} disabled={word.mode.kind === 'repair' || word.gated} onclick={async () => report(await word.setStage(option))}>{STAGE_LABELS[option]}</Button>{/each}
	</div>
</article>
